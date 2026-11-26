// Solunivo Parakeet bridge: NVIDIA's Parakeet (moondream's post-trained
// Ultra, in FluidAudio's Core ML port) reads a finished dictation phrase
// once more, with the names the user is likely to say as its vocabulary.
//
// ONE source for two native hosts, beside SpeechBridge.swift — the macOS
// helper (SPM executable) and the iOS Expo module `solunivo-speech` —
// each of which symlinks this file into its target. The host says where
// the model's files live (`configure`), downloads them when the user
// agreed (`download`), and switches the reading on (`use`): from then on
// SpeechBridge's `readAll` asks `readPhrase` beside Apple's passes, and
// its text, when it comes in time, is the phrase the Assistant reads.
// The phrase's audio is read from memory; nothing is written to disk.
//
// The models: `FluidInference/parakeet-ultra-coreml` (about 613 MB) and,
// for the vocabulary, `FluidInference/parakeet-ctc-110m-coreml` (about
// 99 MB), both CC BY 4.0, fetched from Hugging Face at the commits pinned
// below so a moved branch cannot change what the app runs.
import AVFoundation
import FluidAudio
import Foundation
import Network

enum ParakeetBridgeError: Error, CustomStringConvertible {
  case needsWifi
  case notConfigured
  case notHere
  case unknownVersion(String)

  var description: String {
    switch self {
    case .needsWifi: return "Parakeet downloads on Wi-Fi only."
    case .notConfigured: return "Parakeet has no folder yet."
    case .notHere: return "Parakeet is not on this device."
    case .unknownVersion(let name): return "Unknown Parakeet version: \(name)."
    }
  }
}

/// Whether Parakeet's files are here in full, and the room they take.
struct ParakeetFiles: Sendable {
  let bytes: Int
  let here: Bool

  var json: [String: Any] { ["bytes": bytes, "here": here] }
}

/// A file as the Speech Spike page's model read it, timed.
struct ParakeetSpikeRead: Sendable {
  let audioSeconds: Double
  let ms: Double
  let reading: ParakeetReading
  let rescoreMs: Double

  var json: [String: Any] {
    var json = reading.json
    json["audioSeconds"] = audioSeconds
    json["ms"] = ms
    json["rescoreMs"] = rescoreMs
    return json
  }
}

/// A phrase as Parakeet read it: before and after the vocabulary's rescoring.
struct ParakeetReading: Sendable {
  let raw: String
  let replacements: [(from: String, to: String)]
  let text: String

  var json: [String: Any] {
    [
      "raw": raw,
      "replacements": replacements.map { ["from": $0.from, "to": $0.to] },
      "text": text,
    ]
  }
}

/// The one Parakeet of the process: its files, the model loaded from them,
/// the vocabulary, and whether dictation reads with it.
actor ParakeetEngine {
  static let shared = ParakeetEngine()

  /// The Hugging Face commits the measurements ran (#378).
  private static let pins = [
    "FluidInference/parakeet-ultra-coreml": "95eaa59a39d4394f047a4dc5cce480388a60d1b6",
    "FluidInference/parakeet-ctc-110m-coreml": "accdafd8cf8a2ff1cabe3c11e54416b405d409aa",
  ]
  /// Ultra's share of the whole download, for one progress over both.
  private static let ultraShare = 613.0 / 712.0
  /// The languages Parakeet TDT 0.6B v3 was trained on (NVIDIA's model
  /// card), which Ultra keeps: a phrase listened to in another is Apple's
  /// alone. Measured on Nik's recordings in English and German (#378).
  private static let languages: Set<String> = [
    "bg", "cs", "da", "de", "el", "en", "es", "et", "fi", "fr", "hr", "hu", "it", "lt", "lv",
    "mt", "nl", "pl", "pt", "ro", "ru", "sk", "sl", "sv", "uk",
  ]

  static func reads(_ locale: Locale) -> Bool {
    locale.language.languageCode.map { languages.contains($0.identifier) } ?? false
  }

  /// How alike a span must be spelt to a listed name before the name may
  /// replace it: FluidAudio's own floor (0.55–0.60 by list size) let a
  /// first name said alone take the next word into a full name ("Anna in"
  /// → Anna Lee); at 0.65 Nik's 104 recordings kept every right name and
  /// had none of those (#385). The JS check (`parakeetNames.ts`) stands
  /// behind it for a build without this.
  private static let thresholds = VocabularyBoostingSession.Thresholds(minSimilarity: 0.65)

  /// How long a phrase's answer waits for Parakeet before it goes without it.
  static let readLimit: Duration = .seconds(4)

  private var folder: URL?
  private var on = false
  private var terms: [String] = []
  private var loaded: (version: AsrModelVersion, asr: AsrManager, models: AsrModels)?
  private var ctc: CtcModels?
  private var session: VocabularyBoostingSession?
  private var warming: Task<Void, Never>?
  /// The Speech Spike page's run owns the engine: dictation leaves it alone.
  private var spikeHolds = false
  /// The one load of the model under way: every phrase that needs it waits for it.
  private var loading: (version: AsrModelVersion, generation: Int, task: Task<Void, Error>)?
  /// The one build of the vocabulary's spotter under way.
  private var spotting: Task<Void, Error>?
  /// Moves on whenever the models are let go: a load that ends after that keeps nothing.
  private var generation = 0

  /// Where the files live: the iOS app's caches, the Mac app's profile.
  func configure(folder: URL) {
    if self.folder != folder {
      releaseModels()
      self.folder = folder
    }
    var revisions = ModelRegistry.revisionOverrides
    for (repo, revision) in Self.pins { revisions[repo] = revision }
    ModelRegistry.revisionOverrides = revisions
    // Loads never fetch: FluidAudio would otherwise delete a model that fails
    // to load and download it again, outside the person's Wi-Fi choice.
    // Only `download`, which the store gates, goes online.
    if downloads == 0 { ModelHub.offlineMode = true }
  }

  /// Downloads under way (a cancelled one may still be winding down beside
  /// its replacement): FluidAudio goes online while there is one.
  private var downloads = 0

  private func online<T>(_ work: () async throws -> T) async rethrows -> T {
    downloads += 1
    ModelHub.offlineMode = false
    defer {
      downloads -= 1
      if downloads == 0 { ModelHub.offlineMode = true }
    }
    return try await work()
  }

  private func paths() throws -> (asr: URL, ctc: URL) {
    guard let folder else { throw ParakeetBridgeError.notConfigured }
    return (
      folder.appendingPathComponent(
        AsrModels.defaultCacheDirectory(for: .ultra).lastPathComponent, isDirectory: true),
      folder.appendingPathComponent(
        CtcModels.defaultCacheDirectory(for: .ctc110m).lastPathComponent, isDirectory: true)
    )
  }

  /// Whether both models are here in full, and how much room they take.
  func state() -> ParakeetFiles {
    guard let found = try? paths() else { return ParakeetFiles(bytes: 0, here: false) }
    let here =
      AsrModels.modelsExist(at: found.asr, version: .ultra)
      && CtcModels.modelsExist(at: found.ctc)
    return ParakeetFiles(bytes: folder.map(Self.size(of:)) ?? 0, here: here)
  }

  /// Fetches what is missing of both models (a file already here is kept).
  /// The store prepares them right after (`prepare`), so the first phrase
  /// does not wait for Core ML.
  /// `wifiOnly`: the download stops the moment the device is on mobile data
  /// or in Low Data Mode (FluidAudio's session would go on), rejecting with
  /// `ParakeetBridgeError.needsWifi`; the store waits for Wi-Fi then.
  func download(wifiOnly: Bool, progress: @escaping @Sendable (Double) -> Void) async throws {
    let (asr, ctc) = try paths()
    let share = Self.ultraShare
    let work = Task {
      try await self.online {
        _ = try await AsrModels.download(to: asr, version: .ultra) { step in
          progress(step.fractionCompleted * share)
        }
        try Task.checkCancellation()
        _ = try await CtcModels.download(to: ctc, variant: .ctc110m) { step in
          progress(share + step.fractionCompleted * (1 - share))
        }
      }
    }
    let watch = wifiOnly ? WifiWatch(stopping: work) : nil
    defer { watch?.stop() }
    do {
      try await withTaskCancellationHandler {
        try await work.value
      } onCancel: {
        work.cancel()
      }
    } catch {
      if watch?.tripped == true { throw ParakeetBridgeError.needsWifi }
      throw error
    }
    if watch?.tripped == true { throw ParakeetBridgeError.needsWifi }
    progress(1)
  }

  /// Lets go of the models and deletes their files.
  /// Lets go of the models and deletes their files, once a load still
  /// reading them has stopped.
  func remove() async throws {
    let pending = [loading?.task, spotting].compactMap { $0 }
    releaseModels()
    for task in pending { _ = try? await task.value }
    guard let folder, FileManager.default.fileExists(atPath: folder.path) else { return }
    try FileManager.default.removeItem(at: folder)
  }

  /// Dictation reads with Parakeet (`on`), with these names as its
  /// vocabulary, or no longer does and lets the models go. Nothing is
  /// loaded here: `prepare` does that as dictation starts, and the first
  /// phrase loads them otherwise.
  func use(on: Bool, vocabulary: [String]) {
    self.on = on
    guard on else {
      releaseModels()
      return
    }
    let next = Self.cleaned(vocabulary)
    if next != terms {
      terms = next
      session = nil
      spotting = nil
    }
  }

  /// Loads the models now, in the background, when dictation reads with
  /// Parakeet: called as a phrase starts, so the load runs while it is said.
  func prepare() {
    if on { warm() }
  }

  /// Lets the models go and keeps the switch (the iOS app left the screen):
  /// the next phrase loads them again, in under a second.
  func relieve() {
    releaseModels()
  }

  /// Loads the models in the background when they are here and not loaded:
  /// after a download the Neural Engine prepares them once, which takes
  /// half a minute, so it starts long before a phrase needs them.
  private func warm() {
    guard !spikeHolds, warming == nil, (try? ready(.ultra)) == nil else { return }
    warming = Task {
      _ = try? await self.prepare(.ultra)
      self.warming = nil
    }
  }

  private func ready(_ version: AsrModelVersion) throws -> (AsrManager, AsrModels) {
    guard let loaded, loaded.version == version else { throw ParakeetBridgeError.notHere }
    return (loaded.asr, loaded.models)
  }

  /// The model loaded, with the vocabulary's spotter when there are terms:
  /// one load at a time, which every phrase that needs it waits for, and
  /// none that outlives `releaseModels`.
  private func prepare(_ version: AsrModelVersion) async throws -> (AsrManager, AsrModels) {
    let started = generation
    if (try? ready(version)) == nil {
      if loading?.version != version || loading?.generation != started {
        guard let folder else { throw ParakeetBridgeError.notConfigured }
        let directory = folder.appendingPathComponent(
          AsrModels.defaultCacheDirectory(for: version).lastPathComponent, isDirectory: true)
        guard AsrModels.modelsExist(at: directory, version: version) else {
          throw ParakeetBridgeError.notHere
        }
        loading = (
          version, started, Task { try await self.load(version, from: directory, generation: started) }
        )
      }
      if let task = loading?.task {
        try await task.value
      }
    }
    guard generation == started, let current = try? ready(version) else {
      throw ParakeetBridgeError.notHere
    }
    try await vocabularySession(generation: started)
    return current
  }

  private func load(_ version: AsrModelVersion, from directory: URL, generation started: Int)
    async throws
  {
    defer {
      if loading?.generation == started && loading?.version == version { loading = nil }
    }
    let models = try await AsrModels.load(from: directory, version: version)
    let asr = AsrManager(config: .default)
    try await asr.loadModels(models)
    // Let go of meanwhile (switched off, deleted, the app left): nothing is kept.
    guard generation == started else { return }
    loaded = (version, asr, models)
  }

  /// The vocabulary's spotter for the terms now: built once, which every
  /// phrase that needs it waits for.
  private func vocabularySession(generation started: Int) async throws {
    guard session == nil, !terms.isEmpty else { return }
    let task: Task<Void, Error>
    if let spotting {
      task = spotting
    } else {
      let wanted = terms
      task = Task { try await self.buildSession(for: wanted, generation: started) }
      spotting = task
    }
    defer { if spotting == task { spotting = nil } }
    try await task.value
  }

  private func buildSession(for wanted: [String], generation started: Int) async throws {
    if ctc == nil {
      let (_, directory) = try paths()
      guard CtcModels.modelsExist(at: directory) else { return }
      let models = try await CtcModels.load(from: directory, variant: .ctc110m)
      guard generation == started else { return }
      ctc = models
    }
    guard let ctc else { return }
    let built = try await VocabularyBoostingSession(
      vocabulary: CustomVocabularyContext(terms: wanted.map { CustomVocabularyTerm(text: $0) }),
      ctcModels: ctc, thresholds: Self.thresholds)
    // Other names came meanwhile: the next phrase builds theirs.
    guard generation == started, terms == wanted else { return }
    session = built
  }

  /// A finished phrase as Parakeet reads it, when dictation reads with it
  /// and the models are here: nil otherwise, and nil on any failure (the
  /// answer goes on with Apple's reading then).
  func readPhrase(_ buffers: [AVAudioPCMBuffer], locale: Locale) async -> ParakeetReading? {
    guard on, !spikeHolds, !buffers.isEmpty, Self.reads(locale),
      let model = try? await prepare(.ultra),
      let samples = try? Self.samples(of: buffers), !samples.isEmpty
    else { return nil }
    return try? await read(samples, asr: model.0, models: model.1)
  }

  private func read(_ samples: [Float], asr: AsrManager, models: AsrModels) async throws
    -> ParakeetReading
  {
    var state = TdtDecoderState.make(decoderLayers: await asr.decoderLayerCount)
    // The manager lets go of its models after a transcription; handing the
    // loaded ones back is a few references, not a reload.
    try await asr.loadModels(models)
    let result = try await asr.transcribe(samples, decoderState: &state)
    guard let session,
      let output = await session.rescore(
        text: result.text, tokenTimings: result.tokenTimings ?? [], audioSamples: samples)
    else { return ParakeetReading(raw: result.text, replacements: [], text: result.text) }
    return ParakeetReading(
      raw: result.text,
      replacements: output.replacements.filter(\.shouldReplace).map {
        (from: $0.originalWord, to: $0.replacementWord ?? "")
      },
      text: output.text)
  }

  /// The phrase's blocks as one 16 kHz mono signal, as Parakeet reads it.
  private static func samples(of buffers: [AVAudioPCMBuffer]) throws -> [Float] {
    guard let first = buffers.first else { return [] }
    let frames = buffers.reduce(AVAudioFrameCount(0)) { $0 + $1.frameLength }
    guard let whole = AVAudioPCMBuffer(pcmFormat: first.format, frameCapacity: frames) else {
      return []
    }
    for buffer in buffers where buffer.format == first.format {
      append(buffer, to: whole)
    }
    return try AudioConverter().resampleBuffer(whole)
  }

  private static func append(_ buffer: AVAudioPCMBuffer, to whole: AVAudioPCMBuffer) {
    let offset = Int(whole.frameLength)
    let count = Int(buffer.frameLength)
    let channels = Int(buffer.format.channelCount)
    if let from = buffer.floatChannelData, let to = whole.floatChannelData {
      for channel in 0..<channels {
        (to[channel] + offset).update(from: from[channel], count: count)
      }
    } else if let from = buffer.int16ChannelData, let to = whole.int16ChannelData {
      for channel in 0..<channels {
        (to[channel] + offset).update(from: from[channel], count: count)
      }
    } else if let from = buffer.int32ChannelData, let to = whole.int32ChannelData {
      for channel in 0..<channels {
        (to[channel] + offset).update(from: from[channel], count: count)
      }
    } else {
      return
    }
    whole.frameLength += buffer.frameLength
  }

  private static func cleaned(_ vocabulary: [String]) -> [String] {
    var seen = Set<String>()
    return vocabulary
      .map { $0.split(whereSeparator: \.isWhitespace).joined(separator: " ") }
      .filter { !$0.isEmpty && seen.insert($0.lowercased()).inserted }
  }

  private static func size(of folder: URL) -> Int {
    guard
      let files = FileManager.default.enumerator(
        at: folder, includingPropertiesForKeys: [.totalFileAllocatedSizeKey])
    else { return 0 }
    var bytes = 0
    for case let file as URL in files {
      bytes += (try? file.resourceValues(forKeys: [.totalFileAllocatedSizeKey]))?
        .totalFileAllocatedSize ?? 0
    }
    return bytes
  }

  private func releaseModels() {
    generation += 1
    warming?.cancel()
    warming = nil
    loading?.task.cancel()
    loading = nil
    spotting?.cancel()
    spotting = nil
    loaded = nil
    ctc = nil
    session = nil
  }

  // MARK: The Speech Spike page (iOS): any version, any vocabulary, a file.

  /// Loads `version` with `vocabulary` (fetching what is missing), for the
  /// Speech Spike page's measurements; dictation's reading loads Ultra
  /// with its own vocabulary again when it next reads.
  func spikeLoad(
    version name: String, vocabulary: [String], progress: @escaping ProgressHandler
  ) async throws -> Double {
    let version: AsrModelVersion
    switch name {
    case "v3": version = .v3
    case "ultra": version = .ultra
    default: throw ParakeetBridgeError.unknownVersion(name)
    }
    guard let folder else { throw ParakeetBridgeError.notConfigured }
    releaseModels()
    spikeHolds = true
    let started = Date()
    let (_, ctc) = try paths()
    try await online {
      _ = try await AsrModels.download(
        to: folder.appendingPathComponent(
          AsrModels.defaultCacheDirectory(for: version).lastPathComponent, isDirectory: true),
        version: version, progressHandler: progress)
      if !vocabulary.isEmpty {
        _ = try await CtcModels.download(to: ctc, variant: .ctc110m)
      }
    }
    terms = Self.cleaned(vocabulary)
    _ = try await prepare(version)
    return Date().timeIntervalSince(started) * 1000
  }

  /// A file as the model the Speech Spike page loaded reads it, timed.
  func spikeTranscribe(uri: String) async throws -> ParakeetSpikeRead {
    guard let loaded else { throw ParakeetBridgeError.notHere }
    let url = URL(string: uri) ?? URL(fileURLWithPath: uri)
    let started = Date()
    let samples = try AudioConverter().resampleAudioFile(url)
    var state = TdtDecoderState.make(decoderLayers: await loaded.asr.decoderLayerCount)
    try await loaded.asr.loadModels(loaded.models)
    let result = try await loaded.asr.transcribe(samples, decoderState: &state)
    let heard = Date()
    var reading = ParakeetReading(raw: result.text, replacements: [], text: result.text)
    if let session,
      let output = await session.rescore(
        text: result.text, tokenTimings: result.tokenTimings ?? [], audioSamples: samples)
    {
      reading = ParakeetReading(
        raw: result.text,
        replacements: output.replacements.filter(\.shouldReplace).map {
          (from: $0.originalWord, to: $0.replacementWord ?? "")
        },
        text: output.text)
    }
    let done = Date()
    return ParakeetSpikeRead(
      audioSeconds: Double(samples.count) / 16_000,
      ms: done.timeIntervalSince(started) * 1000, reading: reading,
      rescoreMs: done.timeIntervalSince(heard) * 1000)
  }

  /// Lets the Speech Spike page's model go, and the engine back to dictation.
  func spikeRelease() {
    releaseModels()
    spikeHolds = false
  }
}

/// `readPhrase`, or nil once `limit` has passed: the answer does not wait
/// longer for Parakeet (its pass goes on, and the engine reads the next
/// phrase beside it).
func readWithParakeet(_ buffers: [AVAudioPCMBuffer], locale: Locale) async -> ParakeetReading? {
  let kept = ParakeetAudio(buffers: buffers)
  let answered = ParakeetOnce()
  // Unstructured on purpose: a task group would wait for the Core ML pass,
  // which does not stop when cancelled, and the limit would mean nothing.
  return await withCheckedContinuation { (done: CheckedContinuation<ParakeetReading?, Never>) in
    Task {
      let reading = await ParakeetEngine.shared.readPhrase(kept.buffers, locale: locale)
      if answered.take() { done.resume(returning: reading) }
    }
    Task {
      try? await Task.sleep(for: ParakeetEngine.readLimit)
      if answered.take() { done.resume(returning: nil) }
    }
  }
}

/// True for the first caller only: the one that answers.
private final class ParakeetOnce: @unchecked Sendable {
  private let lock = NSLock()
  private var taken = false

  func take() -> Bool {
    lock.withLock {
      defer { taken = true }
      return !taken
    }
  }
}

/// A finished phrase's audio, no longer written to: safe to hand to the engine.
struct ParakeetAudio: @unchecked Sendable {
  let buffers: [AVAudioPCMBuffer]
}

/// Stops a Wi-Fi-only download the moment the path turns expensive or
/// constrained, before JavaScript hears of it.
private final class WifiWatch: @unchecked Sendable {
  private let monitor = NWPathMonitor()
  private let lock = NSLock()
  private var stopped = false

  var tripped: Bool { lock.withLock { stopped } }

  init(stopping work: Task<Void, Error>) {
    monitor.pathUpdateHandler = { [weak self] path in
      guard path.isExpensive || path.isConstrained, let self else { return }
      self.lock.withLock { self.stopped = true }
      work.cancel()
    }
    monitor.start(queue: DispatchQueue(label: "solunivo.parakeet.wifi"))
  }

  func stop() {
    monitor.cancel()
  }
}
