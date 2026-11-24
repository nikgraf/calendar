// Solunivo speech bridge: dictation over SpeechAnalyzer, one listening at a time.
//
// ONE source for two native hosts — the macOS helper (SPM executable) and
// the iOS Expo module `solunivo-speech` — each of which symlinks this file
// into its target. The host owns the microphone and hands its audio in
// (`append`, any format); this file owns the recognisers. Two listen while
// the phrase is said and report their words as they change: `quick`
// (DictationTranscriber: a word a fraction of a second after it is said)
// and `accurate` (SpeechTranscriber: better words, in bursts). When the
// caller decides a phrase is over (from the words: packages/ai
// `listenForPhrase`), the phrase is read once more, whole, by the
// recogniser phrases were always read with, and that reading is the
// answer: `read` while the microphone stays open (hands-free: words said
// meanwhile are kept, and either join the phrase or begin the next one),
// `finish` as it closes. While a phrase is read the live recognisers
// stop and start again on the audio kept meanwhile (iOS caps the
// recognisers an app runs at once). `cut` lets go of a phrase that landed: the next
// `read` begins after it. With it the phrase is read in the user's other language too
// (`SpeechAssets.other`): a name said the German way inside an English
// sentence is written as English words by the English recogniser and as
// itself by the German one, and the place lookup searches that reading as
// well. The audio stays in memory for those passes only.
//
// The JSON shapes are the `SpeechToText` seam's in packages/ai: words go
// out as (session, source "quick" | "accurate", text = everything that
// recogniser wrote so far, across every phrase of the listening); `read`
// and `finish` answer segments `{text, alternatives}` and `other`, the
// phrase as the other language's recogniser wrote it; `read` adds `mark`,
// where its audio ended, for `cut`.
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
/// wrote it; and as Parakeet read it, when dictation reads with it
/// (ParakeetBridge.swift) and it answered in time.
struct SpeechReading: Sendable {
  let other: String?
  var parakeet: ParakeetReading? = nil
  let segments: [SpeechSegment]

  var json: [String: Any] {
    var json: [String: Any] = ["segments": segments.map(\.json)]
    if let other { json["other"] = other }
    if let parakeet { json["parakeet"] = parakeet.json }
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

/// One listening: the live recognisers, and the audio of the phrase not
/// yet let go of (`cut`), for its final reading. `append` may be called
/// from any one thread at a time (the microphone's tap, the helper's stdin
/// reader), in order.
///
/// The live recognisers stop while a phrase is read with the microphone
/// open, and start again on the audio that came meanwhile: iOS caps the
/// recognisers an app runs at once ("Maximum number of recognizers
/// reached"), and the two live ones and the reading's would be three, the
/// other language's four. The audio keeps arriving and is kept for them,
/// so no word said during the reading goes unheard; it is written a
/// moment later.
final class SpeechListening: @unchecked Sendable {
  typealias Words = @Sendable (_ source: String, _ text: String) -> Void
  typealias Read = (reading: SpeechReading, mark: AVAudioFramePosition)

  /// Audio kept beyond this goes, the oldest first: the app sends a
  /// phrase 60 s after its first word.
  private static let maxSeconds = 90.0
  /// Before a phrase's first words, only this much of the room is kept: a
  /// hands-free listening that waited half a minute for a word must not
  /// read the half minute again. The first words are seen when a
  /// recogniser writes them, a second or so after they were said and
  /// later on a busy device: the lead is generous, since a phrase's start
  /// cut off is a phrase lost, and reading a few seconds of room costs a
  /// tenth of a second.
  private static let leadSeconds = 8.0

  /// The recognisers listening: "accurate", and "quick" when its assets are here.
  let sources: [String]
  private let format: AVAudioFormat
  private let locale: Locale
  /// The quick recogniser's locale; nil when it does not listen.
  private let quickLocale: Locale?
  private let onWords: Words
  /// The second language as chosen (`SpeechAssets.other`): worked out when the phrase is read.
  private let other: String
  private let lock = NSLock()
  private let words: WordsSeen
  /// What each recogniser wrote, the whole listening: live recognisers
  /// started again go on from it.
  private let written: Written
  /// The live recognisers running now (stopped while a phrase is read).
  private var live: LiveRecognisers
  /// Where the microphone's audio goes: the live recognisers', or, while a
  /// phrase is read, the next ones'.
  private var input: AsyncStream<AnalyzerInput>.Continuation
  /// The reading under way with the microphone open: the next one, a
  /// finish and a cancel wait for it, so no two read at once.
  private var pending: Task<Read?, Error>?
  private var converter: AVAudioConverter?
  /// The phrase's audio, each block with where it began in the listening.
  private var kept: [(start: AVAudioFramePosition, buffer: AVAudioPCMBuffer)] = []
  private var keptFrames: AVAudioFramePosition = 0
  /// Every frame taken in so far: where the next block begins.
  private var total: AVAudioFramePosition = 0
  /// A phrase was read and not yet let go of: its audio stays, however
  /// long the pause after it (words that follow may join it).
  private var reading = false
  private var open = true

  private init(
    format: AVAudioFormat, input: AsyncStream<AnalyzerInput>.Continuation, live: LiveRecognisers,
    locale: Locale, onWords: @escaping Words, other: String, quickLocale: Locale?,
    words: WordsSeen, written: Written
  ) {
    self.sources = quickLocale == nil ? ["accurate"] : ["accurate", "quick"]
    self.format = format
    self.input = input
    self.live = live
    self.locale = locale
    self.onWords = onWords
    self.other = other
    self.quickLocale = quickLocale
    self.words = words
    self.written = written
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
    var modules: [any SpeechModule] = [SpeechAssets.accurate(locale, live: true)]
    var quickLocale: Locale?
    if let found = await DictationTranscriber.supportedLocale(equivalentTo: locale) {
      let module = SpeechAssets.quick(found)
      // Not installed (prepare could not): the accurate words alone decide.
      if await AssetInventory.status(forModules: [module]) == .installed {
        quickLocale = found
        modules.append(module)
      }
    }
    guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: modules)
    else {
      throw SpeechBridgeError.failed("no audio format for the recognisers")
    }
    let (stream, input) = AsyncStream<AnalyzerInput>.makeStream()
    let seen = WordsSeen()
    let written = Written()
    let live = try await LiveRecognisers.start(
      locale: locale, quickLocale: quickLocale, stream: stream, written: written, seen: seen,
      onWords: onWords)
    return SpeechListening(
      format: format, input: input, live: live, locale: locale, onWords: onWords, other: other,
      quickLocale: quickLocale, words: seen, written: written)
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
      let frames = AVAudioFramePosition(converted.frameLength)
      kept.append((start: total, buffer: converted))
      keptFrames += frames
      total += frames
      input.yield(AnalyzerInput(buffer: converted))
      trim()
    }
  }

  /// Called under the lock. The oldest audio goes past the cap; and while
  /// no phrase is being read, the room before the phrase's first words,
  /// beyond the lead a phrase keeps (nothing was said in it that a
  /// recogniser wrote down).
  private func trim() {
    let rate = format.sampleRate
    let lead = AVAudioFramePosition(Self.leadSeconds * rate)
    let wordsAt = words.firstAt(now: total)
    while let first = kept.first, kept.count > 1 {
      let end = first.start + AVAudioFramePosition(first.buffer.frameLength)
      let capped = Double(keptFrames) > Self.maxSeconds * rate
      let room = !reading && end < wordsAt - lead
      guard capped || room else { return }
      kept.removeFirst()
      keptFrames -= AVAudioFramePosition(first.buffer.frameLength)
    }
  }

  /// Reads the phrase so far, the microphone left open: its audio, and
  /// `mark`, where it ended. Its audio stays until `cut`. The audio is
  /// taken now, in the order of the calls, so a finish or cancel after it
  /// cannot take it first; the reading runs once one still under way is
  /// done. Nil once the listening was closed.
  func read() -> Task<Read?, Error> {
    lock.withLock {
      guard open else { return Task { nil } }
      reading = true
      let audio = KeptAudio(buffers: kept.map(\.buffer))
      let mark = total
      let before = pending
      let task = Task { () -> Read? in
        _ = try? await before?.value
        return try await self.read(audio, mark: mark)
      }
      pending = task
      return task
    }
  }

  private func read(_ audio: KeptAudio, mark: AVAudioFramePosition) async throws -> Read {
    // The microphone's audio from here on goes to the live recognisers
    // that come next; closed meanwhile, none come, but the live ones still
    // stop before the reading (the finish or cancel waits for it).
    let swapped = lock.withLock { () -> (LiveRecognisers, AsyncStream<AnalyzerInput>?) in
      guard open else { return (live, nil) }
      input.finish()
      let (stream, next) = AsyncStream<AnalyzerInput>.makeStream()
      input = next
      return (live, stream)
    }
    await swapped.0.stop()
    guard let stream = swapped.1 else { return (try await readAll(audio.buffers), mark) }
    // The accurate recogniser, a burst behind, will not write the rest of
    // the phrase now: its next word is a new one, as the quick one's is.
    if let raised = written.levelAccurate() { onWords("accurate", raised) }
    let reading = try await readAll(audio.buffers) { try await self.resume(stream) }
    return (reading, mark)
  }

  /// The live recognisers again, on the audio that came while the phrase
  /// was read. Nothing when the listening was closed meanwhile.
  private func resume(_ stream: AsyncStream<AnalyzerInput>) async throws {
    guard lock.withLock({ open }) else { return }
    let next = try await LiveRecognisers.start(
      locale: locale, quickLocale: quickLocale, stream: stream, written: written, seen: words,
      onWords: onWords)
    let late = lock.withLock { () -> Bool in
      guard open else { return true }
      live = next
      return false
    }
    if late { await next.stop() }
  }

  /// The phrase read up to `mark` landed: its audio goes, and the next
  /// reading begins after it.
  func cut(through mark: AVAudioFramePosition) {
    lock.withLock {
      guard reading else { return }
      reading = false
      words.reset()
      while let first = kept.first, first.start < mark {
        kept.removeFirst()
        keptFrames -= AVAudioFramePosition(first.buffer.frameLength)
      }
    }
  }

  /// Stops listening and reads the phrase once more, whole, and in the
  /// other language beside it. No segments when nothing was said. A
  /// reading under way ends first: the recognisers run one reading at a time.
  func finish() async throws -> SpeechReading {
    let (audio, before) = close()
    _ = try? await before?.value
    await lock.withLock { live }.stop()
    return try await readAll(audio)
  }

  /// Reads audio once more, whole, in the other language beside it, and
  /// with Parakeet when dictation reads with it. No segments when nothing
  /// was said. `appleDone` runs once Apple's recognisers are done with it
  /// (they are capped, Parakeet is not), whether or not they read it.
  func readAll(
    _ audio: [AVAudioPCMBuffer], appleDone: (@Sendable () async throws -> Void)? = nil
  ) async throws -> SpeechReading {
    guard !audio.isEmpty else {
      try await appleDone?()
      return SpeechReading(other: nil, segments: [])
    }
    // The passes only read the audio, at the same time.
    let kept = KeptAudio(buffers: audio)
    async let third = readWithParakeet(kept.buffers, locale: locale)
    async let second = Self.readOther(kept, than: locale, chosen: other, format: format)
    let segments: [SpeechSegment]
    do {
      segments = try await Self.read(kept, locale: locale)
    } catch {
      _ = await second
      try await appleDone?()
      throw error
    }
    let other = await second
    try await appleDone?()
    let parakeet = await third
    guard !segments.isEmpty else { return SpeechReading(other: nil, segments: []) }
    return SpeechReading(
      other: other, parakeet: parakeet?.text.isEmpty == false ? parakeet : nil, segments: segments)
  }

  /// Stops listening and drops the phrase.
  func cancel() async {
    let (_, before) = close()
    _ = try? await before?.value
    await lock.withLock { live }.stop()
  }

  /// No more audio in; hands back what was kept, and keeps none of it, and
  /// the reading still under way.
  private func close() -> ([AVAudioPCMBuffer], Task<Read?, Error>?) {
    lock.withLock {
      open = false
      input.finish()
      let audio = kept.map(\.buffer)
      kept = []
      keptFrames = 0
      return (audio, pending)
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

/// The live recognisers of a listening: one analyzer with the accurate
/// recogniser, and the quick one when it listens, on the microphone's
/// audio; their words go out as they change, each recogniser's text
/// everything it wrote since the listening began (`written`).
private struct LiveRecognisers: @unchecked Sendable {
  let analyzer: SpeechAnalyzer
  let readers: [Task<Void, Never>]

  static func start(
    locale: Locale, quickLocale: Locale?, stream: AsyncStream<AnalyzerInput>, written: Written,
    seen: WordsSeen, onWords: @escaping SpeechListening.Words
  ) async throws -> LiveRecognisers {
    let accurate = SpeechAssets.accurate(locale, live: true)
    var modules: [any SpeechModule] = [accurate]
    var quick: DictationTranscriber?
    if let quickLocale {
      let module = SpeechAssets.quick(quickLocale)
      quick = module
      modules.append(module)
    }
    let analyzer = SpeechAnalyzer(
      modules: modules, options: .init(priority: .userInitiated, modelRetention: .lingering))
    try await analyzer.start(inputSequence: stream)
    // Each goes on from what its recogniser wrote before (an earlier pass).
    var readers = [
      Task {
        var done = written.text("accurate")
        do {
          for try await result in accurate.results {
            let text = joined(done, String(result.text.characters))
            if result.isFinal { done = text }
            written.set("accurate", text)
            seen.mark()
            onWords("accurate", text)
          }
        } catch {}
      }
    ]
    if let quick {
      readers.append(
        Task {
          var done = written.text("quick")
          do {
            for try await result in quick.results {
              let text = joined(done, String(result.text.characters))
              if result.isFinal { done = text }
              written.set("quick", text)
              seen.mark()
              onWords("quick", text)
            }
          } catch {}
        })
    }
    return LiveRecognisers(analyzer: analyzer, readers: readers)
  }

  /// Stops them; once this returns, they write nothing more.
  func stop() async {
    await analyzer.cancelAndFinishNow()
    for reader in readers {
      reader.cancel()
      await reader.value
    }
  }
}

/// What each recogniser of a listening wrote so far, across its passes.
private final class Written: @unchecked Sendable {
  private let lock = NSLock()
  private var texts: [String: String] = [:]

  func text(_ source: String) -> String {
    lock.withLock { texts[source] ?? "" }
  }

  func set(_ source: String, _ text: String) {
    lock.withLock { texts[source] = text }
  }

  /// The accurate recogniser, when it wrote fewer words than the quick
  /// one, is brought up to the quick one's (it writes in bursts, behind
  /// it); answers its new text. Never the quick one: one that heard less
  /// (deaf in a loud room) has not lagged, and raising it would read as
  /// words said after the pause.
  func levelAccurate() -> String? {
    lock.withLock {
      let count = { (text: String) in text.split(whereSeparator: \.isWhitespace).count }
      let accurate = texts["accurate"] ?? ""
      let quick = texts["quick"] ?? ""
      guard !accurate.isEmpty, count(accurate) < count(quick) else { return nil }
      texts["accurate"] = quick
      return quick
    }
  }
}

/// Where the phrase's first words came, as a frame of the listening: the
/// first a recogniser wrote since the listening began or the last phrase
/// was let go of (`reset`). Marked from the recognisers' tasks, read
/// under the listening's lock.
private final class WordsSeen: @unchecked Sendable {
  private let lock = NSLock()
  private var first: AVAudioFramePosition?
  /// Where the listening's audio stands, kept in step by `append`.
  private var now: AVAudioFramePosition = 0

  func mark() {
    lock.withLock {
      if first == nil { first = now }
    }
  }

  func reset() {
    lock.withLock { first = nil }
  }

  /// The frame of the phrase's first words; `now` when none came yet.
  func firstAt(now total: AVAudioFramePosition) -> AVAudioFramePosition {
    lock.withLock {
      now = total
      return first ?? total
    }
  }
}

/// A finished phrase's audio, no longer written to: safe to read from two tasks.
struct KeptAudio: @unchecked Sendable {
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

/// The one listening at a time, by the id its caller gave it: a start
/// replaces (and drops) the listening before, and a late call about an
/// older one does nothing. Starts, reads, finishes and cancels run one after
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

  /// A reading of the phrase so far, the microphone left open; nil when
  /// `id` is not the listening (dropped, or replaced). Only starting it is
  /// queued with the other steps: the reading runs beside them, so a
  /// cancel or a finish closes the microphone at once, and the listening
  /// then waits for the reading before it reads or stops.
  func read(id: Int) -> Task<SpeechListening.Read?, Error> {
    let taken = serial { () -> Task<SpeechListening.Read?, Error>? in
      guard
        let listening = self.lock.withLock({
          self.current?.id == id ? self.current?.listening : nil
        })
      else { return nil }
      return listening.read()
    }
    return Task {
      guard let reading = try await taken.value else { return nil }
      return try await reading.value
    }
  }

  /// The phrase read up to `mark` landed: at once, not queued, as audio is.
  func cut(id: Int, through mark: AVAudioFramePosition) {
    let listening = lock.withLock { current?.id == id ? current?.listening : nil }
    listening?.cut(through: mark)
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
