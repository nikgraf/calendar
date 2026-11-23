import ExpoModulesCore
import FluidAudio
import Foundation

/// NVIDIA's Parakeet TDT 0.6B (v3, and moondream's post-trained Ultra) through
/// FluidAudio's Core ML port, for the Speech Spike page only: it loads one
/// model into the app, transcribes a file with it and lets it go. Nothing in
/// dictation calls it. The models are fetched from Hugging Face into the
/// app's caches the first time one is loaded (hundreds of MB; Core ML then
/// compiles the encoder for the Neural Engine once).
public class SolunivoParakeetModule: Module {
  private let holder = ParakeetHolder()

  public func definition() -> ModuleDefinition {
    Name("SolunivoParakeet")

    Events("onProgress")

    // version: "v3" | "ultra"; vocabulary: the terms the CTC
    // spotter listens for (empty: none, and the spotter is not loaded).
    AsyncFunction("load") { (version: String, vocabulary: [String]) -> [String: Any] in
      try await self.holder.load(version: version, vocabulary: vocabulary) { progress in
        self.sendEvent("onProgress", [
          "fraction": progress.fractionCompleted,
          "phase": String(describing: progress.phase),
        ])
      }
    }

    AsyncFunction("transcribe") { (uri: String) -> [String: Any] in
      try await self.holder.transcribe(uri: uri)
    }

    AsyncFunction("release") { () async in
      await self.holder.release()
    }
  }
}

private enum ParakeetError: Error, CustomStringConvertible {
  case notLoaded
  case unknownVersion(String)

  var description: String {
    switch self {
    case .notLoaded: return "No Parakeet model is loaded."
    case .unknownVersion(let name): return "Unknown Parakeet version: \(name)."
    }
  }
}

/// One model at a time, and every call to it in turn.
private actor ParakeetHolder {
  private var asr: AsrManager?
  private var models: AsrModels?
  private var session: VocabularyBoostingSession?

  private static func folder() throws -> URL {
    let caches = try FileManager.default.url(
      for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    return caches.appendingPathComponent("parakeet", isDirectory: true)
  }

  private static func version(_ name: String) throws -> AsrModelVersion {
    switch name {
    case "v3": return .v3
    case "ultra": return .ultra
    default: throw ParakeetError.unknownVersion(name)
    }
  }

  func load(
    version name: String, vocabulary: [String], progress: @escaping ProgressHandler
  ) async throws -> [String: Any] {
    release()
    let version = try Self.version(name)
    let folder = try Self.folder()
    let started = Date()
    let models = try await AsrModels.downloadAndLoad(
      to: folder.appendingPathComponent(
        AsrModels.defaultCacheDirectory(for: version).lastPathComponent),
      version: version,
      progressHandler: progress)
    let asr = AsrManager(config: .default)
    try await asr.loadModels(models)
    let terms = vocabulary.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    if !terms.isEmpty {
      let ctc = try await CtcModels.downloadAndLoad(
        to: folder.appendingPathComponent(
          CtcModels.defaultCacheDirectory(for: .ctc110m).lastPathComponent),
        variant: .ctc110m)
      session = try await VocabularyBoostingSession(
        vocabulary: CustomVocabularyContext(terms: terms.map { CustomVocabularyTerm(text: $0) }),
        ctcModels: ctc)
    }
    self.asr = asr
    self.models = models
    return ["loadMs": Date().timeIntervalSince(started) * 1000]
  }

  func transcribe(uri: String) async throws -> [String: Any] {
    guard let asr, let models else { throw ParakeetError.notLoaded }
    let url = URL(string: uri) ?? URL(fileURLWithPath: uri)
    let started = Date()
    let samples = try AudioConverter().resampleAudioFile(url)
    var state = TdtDecoderState.make(decoderLayers: await asr.decoderLayerCount)
    // The manager lets go of its models after a transcription; handing the
    // loaded ones back is a few references, not a reload.
    try await asr.loadModels(models)
    let result = try await asr.transcribe(samples, decoderState: &state)
    let heard = Date()
    var text = result.text
    var replacements: [[String: String]] = []
    if let session,
      let output = await session.rescore(
        text: result.text, tokenTimings: result.tokenTimings ?? [], audioSamples: samples)
    {
      text = output.text
      replacements = output.replacements.filter(\.shouldReplace).map {
        ["from": $0.originalWord, "to": $0.replacementWord ?? ""]
      }
    }
    let done = Date()
    return [
      "audioSeconds": Double(samples.count) / 16_000,
      "ms": done.timeIntervalSince(started) * 1000,
      "raw": result.text,
      "replacements": replacements,
      "rescoreMs": done.timeIntervalSince(heard) * 1000,
      "text": text,
    ]
  }

  func release() {
    asr = nil
    models = nil
    session = nil
  }
}
