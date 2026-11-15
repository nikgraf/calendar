import AVFoundation
import ExpoModulesCore
import Foundation

/// Dictation on the iPhone: the microphone (AVAudioEngine) streamed into
/// the shared speech session (SpeechBridge.swift), whose recognisers'
/// words go to JS as `onWords` while the phrase is said. JS decides when
/// the phrase ended (packages/ai `listenForPhrase`) and asks for it read
/// whole (`finish`). Nothing is written to disk.
///
/// The session's steps are queued as the calls arrive, on Expo's serial
/// queue for async functions, so they run in the order JS made them.
public class SolunivoSpeechModule: Module {
  /// Off once the module is torn down: a start still on its way is refused.
  private let alive = Alive()

  public func definition() -> ModuleDefinition {
    Name("SolunivoSpeech")

    Events("onWords")

    // JS reloaded (or the app's host went away) mid-phrase: nothing is
    // left to finish it, so the microphone closes and the phrase goes, and
    // a start that was still on its way opens nothing.
    OnDestroy { [alive] in
      alive.end()
      if #available(iOS 26.0, *) {
        SpeechSessions.shared.cancelAll { Microphone.shared.close() }
      }
    }

    AsyncFunction("prepare") { (locale: String, promise: Promise) in
      guard #available(iOS 26.0, *) else {
        promise.reject("SpeechError", SpeechBridgeError.unsupported("needs iOS 26").message)
        return
      }
      Task {
        do {
          try await SpeechAssets.prepare(locale: locale)
          promise.resolve(nil)
        } catch {
          promise.reject("SpeechError", Self.message(error))
        }
      }
    }

    AsyncFunction("requestMicrophone") { (promise: Promise) in
      if #available(iOS 17.0, *) {
        AVAudioApplication.requestRecordPermission { granted in promise.resolve(granted) }
      } else {
        AVAudioSession.sharedInstance().requestRecordPermission { granted in
          promise.resolve(granted)
        }
      }
    }

    // The Mic Mode the user picked for this app in Control Center. iOS
    // applies it only to audio recorded through voice processing, and no
    // app may pick one itself.
    Function("microphoneMode") { () -> String in
      switch AVCaptureDevice.preferredMicrophoneMode {
      case .voiceIsolation: return "voiceIsolation"
      case .wideSpectrum: return "wideSpectrum"
      default: return "standard"
      }
    }

    // iOS's own Mic Mode picker, opened for this app.
    AsyncFunction("showMicrophoneModes") {
      AVCaptureDevice.showSystemUserInterface(.microphoneModes)
    }.runOnQueue(.main)

    // A locale's language in the user's own: "English (United States)".
    Function("languageName") { (identifier: String) -> String in
      Locale.current.localizedString(forIdentifier: identifier) ?? identifier
    }

    // `session`: the caller's id for the phrase, which its words and the
    // calls about it carry. `voiceProcessing`: the microphone's echo
    // cancellation and noise suppression (Settings › Dictation).
    AsyncFunction("start") {
      [alive] (session: Int, locale: String, voiceProcessing: Bool, promise: Promise) in
      guard #available(iOS 26.0, *) else {
        promise.reject("SpeechError", SpeechBridgeError.unsupported("needs iOS 26").message)
        return
      }
      guard alive.value else {
        promise.reject("SpeechError", SpeechBridgeError.failed("torn down").message)
        return
      }
      let module = WeakModule(self)
      let task = SpeechSessions.shared.start(
        id: session, locale: locale,
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

    AsyncFunction("finish") { (session: Int, promise: Promise) in
      guard #available(iOS 26.0, *) else {
        promise.resolve(nil)
        return
      }
      let task = SpeechSessions.shared.finish(id: session) { Microphone.shared.close() }
      Task {
        do {
          let segments = try await task.value
          promise.resolve(segments.map { ["segments": $0.map(\.json)] })
        } catch {
          promise.reject("SpeechError", Self.message(error))
        }
      }
    }

    AsyncFunction("cancel") { (session: Int, promise: Promise) in
      guard #available(iOS 26.0, *) else {
        promise.resolve(nil)
        return
      }
      let task = SpeechSessions.shared.cancel(id: session) { Microphone.shared.close() }
      Task {
        _ = await task.result
        promise.resolve(nil)
      }
    }
  }

  private static func message(_ error: Error) -> String {
    (error as? SpeechBridgeError)?.message ?? "failed: \(error.localizedDescription)"
  }
}

/// The microphone, for one phrase at a time: its audio goes to that
/// phrase's session as it is recorded. Opened and closed inside the
/// session's own steps, so it follows their order.
@available(iOS 26.0, *)
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
