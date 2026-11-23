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
// answer. With it the phrase is read in the user's other language too
// (`SpeechAssets.other`): a name said the German way inside an English
// sentence is written as English words by the English recogniser and as
// itself by the German one, and the place lookup searches that reading as
// well. The audio stays in memory for those passes only.
//
// The JSON shapes are the `SpeechToText` seam's in packages/ai: words go
// out as (session, source "quick" | "accurate", text = everything that
// recogniser wrote so far); `finish` answers segments `{text, alternatives}`
// and `other`, the phrase as the other language's recogniser wrote it.
import AVFoundation
import Foundation
import Speech

#if os(iOS)
  import UIKit
#endif

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

/// A phrase as finally read: in the language listened in, and, when the
/// user has another one, the whole of it as that language's recogniser
/// wrote it.
struct SpeechReading: Sendable {
  let other: String?
  let segments: [SpeechSegment]

  var json: [String: Any] {
    var json: [String: Any] = ["segments": segments.map(\.json)]
    if let other { json["other"] = other }
    return json
  }
}

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

  /// The second language as the user chose it (Settings › Dictation):
  /// worked out from the device, none, or one the user picked.
  static let automatic = "auto"
  static let off = "off"

  /// The user's other language, as a locale the recogniser has. `chosen`
  /// is the user's choice: `off` none, a language that one (none when it
  /// is the language listened in, or one the recogniser lacks), and
  /// `automatic` the first one that is not the language listened in among
  /// the languages the device is set to, the keyboards it has (iOS) and
  /// the language of its region (an English iPhone in Austria: German).
  /// The names of places and people around the user are in it.
  static func other(than locale: Locale, chosen: String = automatic) async -> Locale? {
    let listened = locale.language.languageCode
    if chosen == off {
      return nil
    }
    if chosen != automatic {
      guard
        let found = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: chosen)),
        found.language.languageCode != listened
      else { return nil }
      return found
    }
    var candidates = Locale.preferredLanguages
    #if os(iOS)
      candidates += await MainActor.run {
        UITextInputMode.activeInputModes.compactMap(\.primaryLanguage)
      }
    #endif
    // Where the device is set to be, before the region the locale asked
    // for carries (an "en-US" asked for on a Mac in Austria).
    for region in [Locale.current.region, locale.region].compactMap({ $0 }) {
      candidates.append(Locale.Language(identifier: "und-\(region.identifier)").maximalIdentifier)
    }
    for identifier in candidates {
      guard
        let found = await SpeechTranscriber.supportedLocale(
          equivalentTo: Locale(identifier: identifier)),
        found.language.languageCode != listened
      else { continue }
      return found
    }
    return nil
  }

  /// Installs the locale's assets; a no-op once present. The accurate
  /// recogniser is required; the quick one is installed when the locale
  /// has it, and listening goes without it otherwise. The other
  /// language's recogniser is fetched on the side and never waited for:
  /// until its assets are here the phrase is read in one language, as
  /// before, and dictation starts no later for it.
  static func prepare(locale identifier: String, other chosen: String = automatic) async throws {
    guard let locale = await locale(identifier) else {
      throw SpeechBridgeError.unsupported("locale not supported: \(identifier)")
    }
    try await install([accurate(locale, live: true)], required: true)
    if let quickLocale = await DictationTranscriber.supportedLocale(equivalentTo: locale) {
      try? await install([quick(quickLocale)], required: false)
    }
    Task.detached(priority: .utility) {
      if let other = await other(than: locale, chosen: chosen) {
        try? await install([accurate(other, live: false)], required: false)
      }
    }
  }

  /// The languages the recogniser has, for the user to choose from (BCP 47,
  /// "de-AT"), and the second language `automatic` comes to for
  /// `identifier`, the language listened in.
  static func languages(for identifier: String) async -> (available: [String], automatic: String?) {
    let available = await SpeechTranscriber.supportedLocales.map { $0.identifier(.bcp47) }
    guard let listened = await locale(identifier) else {
      return (Array(Set(available)).sorted(), nil)
    }
    let automatic = await other(than: listened)
    return (Array(Set(available)).sorted(), automatic?.identifier(.bcp47))
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
  /// The second language as chosen (`SpeechAssets.other`): worked out when the phrase is finished.
  private let other: String
  private let readers: [Task<Void, Never>]
  private let lock = NSLock()
  private var converter: AVAudioConverter?
  private var kept: [AVAudioPCMBuffer] = []
  private var keptFrames: AVAudioFramePosition = 0
  private var open = true

  private init(
    analyzer: SpeechAnalyzer, format: AVAudioFormat,
    input: AsyncStream<AnalyzerInput>.Continuation, locale: Locale, other: String,
    readers: [Task<Void, Never>], sources: [String]
  ) {
    self.sources = sources
    self.analyzer = analyzer
    self.format = format
    self.input = input
    self.locale = locale
    self.other = other
    self.readers = readers
  }

  static func start(
    locale identifier: String, other: String = SpeechAssets.automatic,
    onWords: @escaping Words
  ) async throws
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
      analyzer: analyzer, format: format, input: input, locale: locale, other: other,
      readers: readers, sources: quick == nil ? ["accurate"] : ["accurate", "quick"])
  }

  /// The other language to read the phrase in: only when its recogniser is
  /// installed (prepare could) and takes the audio as it is kept. Asked
  /// when the phrase is finished, beside its reading: listening never
  /// waits for it.
  fileprivate static func otherReader(
    than locale: Locale, chosen: String, format: AVAudioFormat
  ) async -> Locale? {
    guard let other = await SpeechAssets.other(than: locale, chosen: chosen) else { return nil }
    let module = SpeechAssets.accurate(other, live: false)
    guard await AssetInventory.status(forModules: [module]) == .installed,
      await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [module]) == format
    else { return nil }
    return other
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

  /// Stops listening and reads the phrase once more, whole, and in the
  /// other language beside it. No segments when nothing was said.
  func finish() async throws -> SpeechReading {
    let audio = close()
    await analyzer.cancelAndFinishNow()
    for reader in readers { reader.cancel() }
    guard !audio.isEmpty else { return SpeechReading(other: nil, segments: []) }
    // Both passes only read the audio, at the same time.
    let kept = KeptAudio(buffers: audio)
    async let second = Self.readOther(kept, than: locale, chosen: other, format: format)
    let segments = try await Self.read(kept, locale: locale)
    let other = await second
    return SpeechReading(other: segments.isEmpty ? nil : other, segments: segments)
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
  fileprivate static func read(_ audio: KeptAudio, locale: Locale) async throws
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
    for buffer in audio.buffers { input.yield(AnalyzerInput(buffer: buffer)) }
    input.finish()
    if let last = try await analyzer.analyzeSequence(stream) {
      try await analyzer.finalizeAndFinish(through: last)
    } else {
      await analyzer.cancelAndFinishNow()
    }
    return try await collect.value
  }
}

/// A finished phrase's audio, no longer written to: safe to read from two tasks.
private struct KeptAudio: @unchecked Sendable {
  let buffers: [AVAudioPCMBuffer]
}

extension SpeechListening {
  /// The phrase as the other language's recogniser writes it: nil without
  /// one, when it wrote nothing, or when it failed (the answer does not
  /// wait on it then, nor fail with it).
  fileprivate static func readOther(
    _ audio: KeptAudio, than listened: Locale, chosen: String, format: AVAudioFormat
  ) async -> String? {
    guard let locale = await otherReader(than: listened, chosen: chosen, format: format),
      let segments = try? await read(audio, locale: locale)
    else { return nil }
    let text = segments.map(\.text).joined(separator: " ")
      .split(whereSeparator: \.isWhitespace).joined(separator: " ")
    return text.isEmpty ? nil : text
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
/// another in the order they were called: each is queued synchronously,
/// as the call arrives (the helper's stdin reader, the iOS module's serial
/// queue), and its task is what the caller awaits. Two bars that start and
/// give up at the same moment cannot leave the older phrase listening.
/// A host that owns the microphone (iOS) opens and closes it inside those
/// steps (`open`, `close`), so it follows the same order. A start closes
/// it first, so a phrase it replaces cannot leave it on, even when the new
/// one then fails to start.
final class SpeechSessions: @unchecked Sendable {
  static let shared = SpeechSessions()

  private let lock = NSLock()
  private var current: (id: Int, listening: SpeechListening)?
  /// The step queued last: the next one waits for it.
  private var tail: Task<Void, Never>?

  /// Queues a start; its task answers the recognisers that listen.
  func start(
    id: Int, locale: String, other: String = SpeechAssets.automatic,
    onWords: @escaping SpeechListening.Words,
    open: (@Sendable () throws -> Void)? = nil, close: (@Sendable () -> Void)? = nil
  ) -> Task<[String], Error> {
    serial {
      close?()
      await self.take(nil)?.cancel()
      let listening = try await SpeechListening.start(
        locale: locale, other: other, onWords: onWords)
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

  /// Queues a finish; nil when `id` is not the phrase listened to (dropped, or replaced).
  func finish(id: Int, close: (@Sendable () -> Void)? = nil) -> Task<SpeechReading?, Error> {
    serial {
      guard let listening = self.take(id) else { return nil }
      close?()
      return try await listening.finish()
    }
  }

  /// Queues dropping whatever phrase is listened to: its host went away (a reload).
  @discardableResult
  func cancelAll(close: (@Sendable () -> Void)? = nil) -> Task<Void, Error> {
    serial {
      close?()
      await self.take(nil)?.cancel()
    }
  }

  @discardableResult
  func cancel(id: Int, close: (@Sendable () -> Void)? = nil) -> Task<Void, Error> {
    serial {
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

  /// Queues `work` behind the step before, now, in the caller's order.
  private func serial<T: Sendable>(_ work: @escaping @Sendable () async throws -> T) -> Task<
    T, Error
  > {
    lock.withLock {
      let previous = tail
      let task = Task<T, Error> {
        await previous?.value
        return try await work()
      }
      tail = Task { _ = try? await task.value }
      return task
    }
  }
}
