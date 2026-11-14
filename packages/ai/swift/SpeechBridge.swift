// Solunivo speech bridge: one spoken phrase at a time, over SpeechAnalyzer.
//
// ONE source for two native hosts — the macOS helper (SPM executable) and
// the iOS Expo module `solunivo-speech` — each of which symlinks this file
// into its target. The host owns the microphone and hands its audio in
// (`append`, any format); this file owns the recognisers. Two listen while
// the phrase is said and report their words as they change: `quick`
// (DictationTranscriber: a word a fraction of a second after it is said)
// and `accurate` (SpeechTranscriber: better words, in bursts). When the
// caller decides the phrase is over (`finish`, from the words: packages/ai
// `listenForPhrase`), the phrase is read once more, whole, by the
// recogniser phrases were always read with, and that reading is the
// answer. The audio stays in memory for that pass only.
//
// The JSON shapes are the `SpeechToText` seam's in packages/ai: words go
// out as (session, source "quick" | "accurate", text = everything that
// recogniser wrote so far); `finish` answers segments `{text, alternatives}`.
import AVFoundation
import Foundation
import Speech

enum SpeechBridgeError: Error, Sendable {
  case failed(String)
  case unsupported(String)

  var message: String {
    switch self {
    case .failed(let text): return "failed: \(text)"
    case .unsupported(let text): return "unsupported: \(text)"
    }
  }
}

/// One span of the phrase as finally read, with the other readings the
/// recogniser weighed for it (the place lookup will want them).
struct SpeechSegment: Sendable {
  let alternatives: [String]
  let text: String

  var json: [String: Any] { ["alternatives": alternatives, "text": text] }
}

@available(iOS 26.0, macOS 26.0, *)
enum SpeechAssets {
  /// The recogniser phrases are read with: also the one that listens as `accurate`.
  static func accurate(_ locale: Locale, live: Bool) -> SpeechTranscriber {
    SpeechTranscriber(
      locale: locale, transcriptionOptions: [],
      reportingOptions: live ? [.volatileResults, .fastResults] : [.alternativeTranscriptions],
      attributeOptions: [])
  }

  static func quick(_ locale: Locale) -> DictationTranscriber {
    DictationTranscriber(
      locale: locale, contentHints: [.shortForm], transcriptionOptions: [.punctuation],
      reportingOptions: [.volatileResults], attributeOptions: [])
  }

  /// The supported locale closest to `identifier`, or nil when there is none.
  static func locale(_ identifier: String) async -> Locale? {
    await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: identifier))
  }

  /// Installs the locale's assets; a no-op once present. The accurate
  /// recogniser is required; the quick one is installed when the locale
  /// has it, and listening goes without it otherwise.
  static func prepare(locale identifier: String) async throws {
    guard let locale = await locale(identifier) else {
      throw SpeechBridgeError.unsupported("locale not supported: \(identifier)")
    }
    try await install([accurate(locale, live: true)], required: true)
    if let quickLocale = await DictationTranscriber.supportedLocale(equivalentTo: locale) {
      try? await install([quick(quickLocale)], required: false)
    }
  }

  private static func install(_ modules: [any SpeechModule], required: Bool) async throws {
    switch await AssetInventory.status(forModules: modules) {
    case .installed:
      return
    case .supported, .downloading:
      if let request = try await AssetInventory.assetInstallationRequest(supporting: modules) {
        try await request.downloadAndInstall()
      }
    case .unsupported:
      if required { throw SpeechBridgeError.unsupported("assets unsupported") }
    @unknown default:
      if required { throw SpeechBridgeError.unsupported("unknown asset status") }
    }
  }
}

/// One phrase being listened to: the live recognisers, and the audio for
/// the final reading. `append` may be called from any one thread at a
/// time (the microphone's tap, the helper's stdin reader), in order.
@available(iOS 26.0, macOS 26.0, *)
final class SpeechListening: @unchecked Sendable {
  typealias Words = @Sendable (_ source: String, _ text: String) -> Void

  /// Audio kept beyond this is dropped: the app sends a phrase after 60 s.
  private static let maxSeconds = 90.0

  /// The recognisers listening: "accurate", and "quick" when its assets are here.
  let sources: [String]
  private let analyzer: SpeechAnalyzer
  private let format: AVAudioFormat
  private let input: AsyncStream<AnalyzerInput>.Continuation
  private let locale: Locale
  private let readers: [Task<Void, Never>]
  private let lock = NSLock()
  private var converter: AVAudioConverter?
  private var kept: [AVAudioPCMBuffer] = []
  private var keptFrames: AVAudioFramePosition = 0
  private var open = true

  private init(
    analyzer: SpeechAnalyzer, format: AVAudioFormat,
    input: AsyncStream<AnalyzerInput>.Continuation, locale: Locale, readers: [Task<Void, Never>],
    sources: [String]
  ) {
    self.sources = sources
    self.analyzer = analyzer
    self.format = format
    self.input = input
    self.locale = locale
    self.readers = readers
  }

  static func start(locale identifier: String, onWords: @escaping Words) async throws
    -> SpeechListening
  {
    guard let locale = await SpeechAssets.locale(identifier) else {
      throw SpeechBridgeError.unsupported("locale not supported: \(identifier)")
    }
    let accurate = SpeechAssets.accurate(locale, live: true)
    var modules: [any SpeechModule] = [accurate]
    var quick: DictationTranscriber?
    if let quickLocale = await DictationTranscriber.supportedLocale(equivalentTo: locale) {
      let module = SpeechAssets.quick(quickLocale)
      // Not installed (prepare could not): the accurate words alone decide.
      if await AssetInventory.status(forModules: [module]) == .installed {
        quick = module
        modules.append(module)
      }
    }
    guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: modules)
    else {
      throw SpeechBridgeError.failed("no audio format for the recognisers")
    }
    let (stream, input) = AsyncStream<AnalyzerInput>.makeStream()
    let analyzer = SpeechAnalyzer(
      modules: modules, options: .init(priority: .userInitiated, modelRetention: .lingering))
    try await analyzer.start(inputSequence: stream)
    var readers = [
      Task {
        var done = ""
        do {
          for try await result in accurate.results {
            let text = joined(done, String(result.text.characters))
            if result.isFinal { done = text }
            onWords("accurate", text)
          }
        } catch {}
      }
    ]
    if let quick {
      readers.append(
        Task {
          var done = ""
          do {
            for try await result in quick.results {
              let text = joined(done, String(result.text.characters))
              if result.isFinal { done = text }
              onWords("quick", text)
            }
          } catch {}
        })
    }
    return SpeechListening(
      analyzer: analyzer, format: format, input: input, locale: locale, readers: readers,
      sources: quick == nil ? ["accurate"] : ["accurate", "quick"])
  }

  /// The microphone's audio, in whatever format it comes. The buffer is the
  /// session's afterwards when it is already in the recognisers' format.
  func append(_ buffer: AVAudioPCMBuffer) {
    lock.withLock {
      guard open, let converted = convert(buffer) else { return }
      guard Double(keptFrames) < Self.maxSeconds * format.sampleRate else { return }
      kept.append(converted)
      keptFrames += AVAudioFramePosition(converted.frameLength)
      input.yield(AnalyzerInput(buffer: converted))
    }
  }

  /// Stops listening and reads the phrase once more, whole. Empty when
  /// nothing was said.
  func finish() async throws -> [SpeechSegment] {
    let audio = close()
    await analyzer.cancelAndFinishNow()
    for reader in readers { reader.cancel() }
    guard !audio.isEmpty else { return [] }
    return try await Self.read(audio, locale: locale)
  }

  /// Stops listening and drops the phrase.
  func cancel() async {
    _ = close()
    await analyzer.cancelAndFinishNow()
    for reader in readers { reader.cancel() }
  }

  /// No more audio in; hands back what was kept, and keeps none of it.
  private func close() -> [AVAudioPCMBuffer] {
    lock.withLock {
      open = false
      input.finish()
      let audio = kept
      kept = []
      keptFrames = 0
      return audio
    }
  }

  /// Called under the lock: the converter keeps state between blocks.
  private func convert(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
    if buffer.format == format { return buffer }
    if converter?.inputFormat != buffer.format {
      converter = AVAudioConverter(from: buffer.format, to: format)
      // A microphone with more than one channel: all of them, mixed.
      converter?.downmix = true
    }
    guard let converter, buffer.frameLength > 0 else { return nil }
    let ratio = format.sampleRate / buffer.format.sampleRate
    let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 32
    guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else {
      return nil
    }
    var given = false
    var error: NSError?
    let status = converter.convert(to: out, error: &error) { _, inputStatus in
      if given {
        inputStatus.pointee = .noDataNow
        return nil
      }
      given = true
      inputStatus.pointee = .haveData
      return buffer
    }
    guard status != .error, out.frameLength > 0 else { return nil }
    return out
  }

  /// The final reading: the whole phrase through the recogniser phrases
  /// were always read with, alternatives included.
  private static func read(_ audio: [AVAudioPCMBuffer], locale: Locale) async throws
    -> [SpeechSegment]
  {
    let transcriber = SpeechAssets.accurate(locale, live: false)
    let analyzer = SpeechAnalyzer(
      modules: [transcriber], options: .init(priority: .userInitiated, modelRetention: .lingering))
    let collect = Task { () -> [SpeechSegment] in
      var segments: [SpeechSegment] = []
      for try await result in transcriber.results where result.isFinal {
        segments.append(
          SpeechSegment(
            alternatives: result.alternatives.map { String($0.characters) },
            text: String(result.text.characters)))
      }
      return segments
    }
    let (stream, input) = AsyncStream<AnalyzerInput>.makeStream()
    for buffer in audio { input.yield(AnalyzerInput(buffer: buffer)) }
    input.finish()
    if let last = try await analyzer.analyzeSequence(stream) {
      try await analyzer.finalizeAndFinish(through: last)
    } else {
      await analyzer.cancelAndFinishNow()
    }
    return try await collect.value
  }
}

/// Everything a recogniser wrote: its finished parts, then the part it is
/// still writing.
private func joined(_ done: String, _ text: String) -> String {
  (done + " " + text).split(whereSeparator: \.isWhitespace).joined(separator: " ")
}

/// The one phrase listened to at a time, by the id its caller gave it: a
/// start replaces (and drops) the phrase before, and a late call about an
/// older phrase does nothing. Starts, finishes and cancels run one after
/// another in the order they were asked for, so two bars that start and
/// give up at the same moment cannot leave the older phrase listening.
/// A host that owns the microphone (iOS) opens and closes it inside those
/// steps (`open`, `close`), so it follows the same order. A start closes
/// it first, so a phrase it replaces cannot leave it on, even when the new
/// one then fails to start.
@available(iOS 26.0, macOS 26.0, *)
final class SpeechSessions: @unchecked Sendable {
  static let shared = SpeechSessions()

  private let lock = NSLock()
  private var current: (id: Int, listening: SpeechListening)?
  /// The step asked for last: the next one waits for it.
  private var tail: Task<Void, Never>?

  /// The recognisers that listen to the phrase.
  func start(
    id: Int, locale: String, onWords: @escaping SpeechListening.Words,
    open: (@Sendable () throws -> Void)? = nil, close: (@Sendable () -> Void)? = nil
  ) async throws -> [String] {
    try await serial {
      close?()
      await self.take(nil)?.cancel()
      let listening = try await SpeechListening.start(locale: locale, onWords: onWords)
      self.lock.withLock { self.current = (id, listening) }
      do {
        try open?()
      } catch {
        await self.take(id)?.cancel()
        throw error
      }
      return listening.sources
    }
  }

  func append(id: Int, _ buffer: AVAudioPCMBuffer) {
    let listening = lock.withLock { current?.id == id ? current?.listening : nil }
    listening?.append(buffer)
  }

  /// Nil when `id` is not the phrase listened to (dropped, or replaced).
  func finish(id: Int, close: (@Sendable () -> Void)? = nil) async throws -> [SpeechSegment]? {
    try await serial {
      guard let listening = self.take(id) else { return nil }
      close?()
      return try await listening.finish()
    }
  }

  /// Drops whatever phrase is listened to: its host went away (a reload).
  func cancelAll(close: (@Sendable () -> Void)? = nil) async {
    _ = try? await serial {
      close?()
      await self.take(nil)?.cancel()
    }
  }

  func cancel(id: Int, close: (@Sendable () -> Void)? = nil) async {
    _ = try? await serial {
      guard let listening = self.take(id) else { return }
      close?()
      await listening.cancel()
    }
  }

  /// Takes the current phrase off: any phrase when `id` is nil, else only
  /// the one with that id.
  private func take(_ id: Int?) -> SpeechListening? {
    lock.withLock {
      guard let current, id == nil || current.id == id else { return nil }
      self.current = nil
      return current.listening
    }
  }

  private func serial<T: Sendable>(_ work: @escaping @Sendable () async throws -> T) async throws
    -> T
  {
    let task = lock.withLock {
      let previous = tail
      let task = Task<T, Error> {
        await previous?.value
        return try await work()
      }
      tail = Task { _ = try? await task.value }
      return task
    }
    return try await task.value
  }
}
