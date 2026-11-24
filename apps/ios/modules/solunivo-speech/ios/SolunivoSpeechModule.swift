import AVFoundation
import ExpoModulesCore
import Foundation

/// Dictation on the iPhone: the microphone (AVAudioEngine) streamed into
/// the shared speech session (SpeechBridge.swift), whose recognisers'
/// words go to JS as `onWords` while the phrase is said. JS decides when
/// a phrase ended (packages/ai `listenForPhrase`) and asks for it read
/// whole: `read` with the microphone left open (hands-free), `finish` as
/// it closes. Nothing is written to disk.
///
/// The session's steps are queued as the calls arrive, on Expo's serial
/// queue for async functions, so they run in the order JS made them.
///
/// Parakeet (ParakeetBridge.swift) reads each finished phrase once more
/// when dictation reads with it: its files live in the app's caches, the
/// download reports `onParakeetProgress`, and `parakeetUse` switches the
/// reading on with the names the user is likely to say.
public class SolunivoSpeechModule: Module {
  /// Off once the module is torn down: a start still on its way is refused.
  private let alive = Alive()
  private let downloads = ParakeetDownloads()

  public func definition() -> ModuleDefinition {
    Name("SolunivoSpeech")

    Events("onWords", "onParakeetProgress")


    // JS reloaded (or the app's host went away) mid-phrase: nothing is
    // left to finish it, so the microphone closes and the phrase goes, and
    // a start that was still on its way opens nothing.
    OnDestroy { [alive] in
      alive.end()
      SpeechSessions.shared.cancelAll { Microphone.shared.close() }
    }

    AsyncFunction("prepare") { (locale: String, other: String, promise: Promise) in
      Task {
        do {
          try await SpeechAssets.prepare(locale: locale, other: other)
          promise.resolve(nil)
        } catch {
          promise.reject("SpeechError", Self.message(error))
        }
      }
    }

    AsyncFunction("requestMicrophone") { (promise: Promise) in
      AVAudioApplication.requestRecordPermission { granted in promise.resolve(granted) }
    }

    // The Mic Mode the user picked for this app in Control Center. iOS
    // applies it only to audio recorded through voice processing, and no
    // app may pick one itself. No picker is offered from Settings: iOS
    // offers the modes while the app records, so a picker opened with the
    // microphone off may have none to give.
    Function("microphoneMode") { () -> String in
      switch AVCaptureDevice.preferredMicrophoneMode {
      case .voiceIsolation: return "voiceIsolation"
      case .wideSpectrum: return "wideSpectrum"
      default: return "standard"
      }
    }

    // A locale's language in English, the app's own: "German (Austria)".
    Function("languageName") { (identifier: String) -> String in
      Locale(identifier: "en").localizedString(forIdentifier: identifier) ?? identifier
    }

    // The languages dictation may listen in, and the second language
    // Automatic comes to for `locale` (Settings › Dictation).
    AsyncFunction("languages") { (locale: String, promise: Promise) in
      Task {
        let (available, automatic) = await SpeechAssets.languages(for: locale)
        var result: [String: Any] = ["available": available]
        if let automatic { result["automatic"] = automatic }
        promise.resolve(result)
      }
    }

    // `session`: the caller's id for the phrase, which its words and the
    // calls about it carry. `voiceProcessing`: the microphone's echo
    // cancellation and noise suppression (Settings › Dictation). `other`:
    // the second language as chosen there ("auto", "off" or a language).
    AsyncFunction("start") {
      [alive] (
        session: Int, locale: String, voiceProcessing: Bool, other: String, promise: Promise
      ) in
      guard alive.value else {
        promise.reject("SpeechError", SpeechBridgeError.failed("torn down").message)
        return
      }
      let module = WeakModule(self)
      let task = SpeechSessions.shared.start(
        id: session, locale: locale, other: other,
        onWords: { source, text in
          module.value?.sendEvent(
            "onWords", ["session": session, "source": source, "text": text])
        },
        open: {
          guard alive.value else { throw SpeechBridgeError.failed("torn down") }
          try Microphone.shared.open(session: session, voiceProcessing: voiceProcessing)
        },
        close: { Microphone.shared.close() })
      Task {
        do {
          promise.resolve(["sources": try await task.value])
        } catch {
          promise.reject("SpeechError", Self.message(error))
        }
      }
    }

    // The phrase so far, read while the microphone stays open (hands-free:
    // what is said meanwhile is recorded). `mark`: where its audio ended.
    AsyncFunction("read") { (session: Int, promise: Promise) in
      let task = SpeechSessions.shared.read(id: session)
      Task {
        do {
          guard let read = try await task.value else {
            promise.resolve(nil)
            return
          }
          var json = read.reading.json
          json["mark"] = Int(read.mark)
          promise.resolve(json)
        } catch {
          promise.reject("SpeechError", Self.message(error))
        }
      }
    }

    // The phrase read up to `mark` landed: its audio goes.
    Function("cut") { (session: Int, mark: Int) in
      SpeechSessions.shared.cut(id: session, through: AVAudioFramePosition(mark))
    }

    AsyncFunction("finish") { (session: Int, promise: Promise) in
      let task = SpeechSessions.shared.finish(id: session) { Microphone.shared.close() }
      Task {
        do {
          promise.resolve(try await task.value?.json)
        } catch {
          promise.reject("SpeechError", Self.message(error))
        }
      }
    }

    AsyncFunction("cancel") { (session: Int, promise: Promise) in
      let task = SpeechSessions.shared.cancel(id: session) { Microphone.shared.close() }
      Task {
        _ = await task.result
        promise.resolve(nil)
      }
    }

    // Whether Parakeet's files are here in full, and the room they take.
    AsyncFunction("parakeetState") { () async -> [String: Any] in
      await Self.engine().state().json
    }

    // Fetches what is missing of Parakeet's files, reporting
    // `onParakeetProgress`; a second call while one runs waits for it.
    // Rejects "cancelled" after `parakeetCancel`.
    AsyncFunction("parakeetDownload") { (promise: Promise) in
      let module = WeakModule(self)
      let task = self.downloads.start {
        try await Self.engine().download { fraction in
          module.value?.sendEvent("onParakeetProgress", ["fraction": fraction])
        }
      }
      Task {
        do {
          try await task.value
          promise.resolve(nil)
        } catch is CancellationError {
          promise.reject("ParakeetError", "cancelled")
        } catch {
          promise.reject("ParakeetError", "\(error)")
        }
      }
    }

    Function("parakeetCancel") { [downloads] in
      downloads.cancel()
    }

    AsyncFunction("parakeetRemove") { [downloads] () async throws in
      downloads.cancel()
      try await Self.engine().remove()
    }

    // Dictation reads with Parakeet, with these names as its vocabulary
    // (the models load in the background), or no longer does.
    AsyncFunction("parakeetUse") { (on: Bool, vocabulary: [String]) async in
      await Self.engine().use(on: on, vocabulary: vocabulary)
    }

    // As a phrase starts: the models load in the background while it is
    // said, when dictation reads with Parakeet.
    AsyncFunction("parakeetPrepare") { () async in
      await Self.engine().prepare()
    }

    // The app left the screen: the models go, the switch stays.
    AsyncFunction("parakeetRelieve") { () async in
      await Self.engine().relieve()
    }

    // The Speech Spike page (Settings › Advanced): any version, any
    // vocabulary, a file; `onParakeetProgress` while the model downloads.
    AsyncFunction("parakeetSpikeLoad") {
      (version: String, vocabulary: [String]) async throws -> [String: Any] in
      let module = WeakModule(self)
      let loadMs = try await Self.engine().spikeLoad(
        version: version, vocabulary: vocabulary
      ) { progress in
        module.value?.sendEvent(
          "onParakeetProgress", ["fraction": progress.fractionCompleted])
      }
      return ["loadMs": loadMs]
    }

    AsyncFunction("parakeetSpikeTranscribe") { (uri: String) async throws -> [String: Any] in
      try await Self.engine().spikeTranscribe(uri: uri).json
    }

    AsyncFunction("parakeetSpikeRelease") { () async in
      await Self.engine().spikeRelease()
    }
  }

  /// Parakeet's engine, its files in the app's caches: set before every
  /// call, so none can reach it before it knows where they are.
  private static func engine() async -> ParakeetEngine {
    if let caches = try? FileManager.default.url(
      for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    {
      await ParakeetEngine.shared.configure(
        folder: caches.appendingPathComponent("parakeet", isDirectory: true))
    }
    return ParakeetEngine.shared
  }

  private static func message(_ error: Error) -> String {
    (error as? SpeechBridgeError)?.message ?? "failed: \(error.localizedDescription)"
  }
}

/// The microphone, for one phrase at a time: its audio goes to that
/// phrase's session as it is recorded. Opened and closed inside the
/// session's own steps, so it follows their order.
private final class Microphone: @unchecked Sendable {
  static let shared = Microphone()

  private let lock = NSLock()
  private var engine: AVAudioEngine?

  func open(session: Int, voiceProcessing: Bool) throws {
    close()
    let audio = AVAudioSession.sharedInstance()
    try audio.setCategory(
      .playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothHFP])
    try audio.setActive(true)
    let engine = AVAudioEngine()
    let input = engine.inputNode
    var tapped = false
    // Anything that fails once the session is active gives it back: other
    // apps' audio must not stay interrupted for a dictation that never ran.
    do {
      if voiceProcessing {
        try input.setVoiceProcessingEnabled(true)
      }
      let format = input.outputFormat(forBus: 0)
      guard format.sampleRate > 0, format.channelCount > 0 else {
        throw SpeechBridgeError.failed("no microphone")
      }
      input.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, _ in
        SpeechSessions.shared.append(id: session, buffer)
      }
      tapped = true
      engine.prepare()
      try engine.start()
    } catch {
      if tapped {
        input.removeTap(onBus: 0)
      }
      engine.stop()
      try? audio.setActive(false, options: .notifyOthersOnDeactivation)
      throw error
    }
    lock.withLock { self.engine = engine }
  }

  /// Stops recording and gives the audio session back: music another app
  /// paused for it plays on, and the microphone indicator goes out.
  func close() {
    guard let engine = lock.withLock({ () -> AVAudioEngine? in
      let engine = self.engine
      self.engine = nil
      return engine
    }) else { return }
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }
}

/// Whether the module still stands: read from the session's steps.
private final class Alive: @unchecked Sendable {
  private let lock = NSLock()
  private var standing = true

  var value: Bool { lock.withLock { standing } }

  func end() {
    lock.withLock { standing = false }
  }
}

/// The module as the recognisers' words reach it, from their tasks: held
/// weakly, so a session does not keep a module JS let go.
private final class WeakModule: @unchecked Sendable {
  weak var value: SolunivoSpeechModule?

  init(_ value: SolunivoSpeechModule?) {
    self.value = value
  }
}

/// The one Parakeet download at a time: a second call joins it, a cancel
/// stops it. A cancelled one that winds down after the next started leaves
/// that one's slot alone, so a later cancel still stops it.
private final class ParakeetDownloads: @unchecked Sendable {
  private let lock = NSLock()
  private var current: (id: Int, task: Task<Void, Error>)?
  private var started = 0

  func start(_ work: @escaping @Sendable () async throws -> Void) -> Task<Void, Error> {
    lock.withLock {
      if let current { return current.task }
      started += 1
      let id = started
      let task = Task {
        defer { self.finished(id) }
        try await work()
      }
      current = (id, task)
      return task
    }
  }

  private func finished(_ id: Int) {
    lock.withLock {
      if current?.id == id { current = nil }
    }
  }

  func cancel() {
    lock.withLock {
      current?.task.cancel()
      current = nil
    }
  }
}
