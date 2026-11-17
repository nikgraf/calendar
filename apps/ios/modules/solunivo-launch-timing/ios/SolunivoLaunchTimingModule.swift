import ExpoModulesCore
import Foundation
import UIKit

/// When this launch began, for the launch times Settings › Advanced ›
/// Diagnostics shows. JavaScript can't see the time before its bundle
/// runs: expo-updates' wait at launch, React Native's start and the
/// bundle's load all happen first, and React Native's own startup marker
/// is set only after them.
///
/// The start is the process's, from the kernel, unless iOS prewarmed the
/// process: then it may have started minutes before anyone tapped the
/// icon, and UIKit's launch call is the start instead.
final class LaunchClock: @unchecked Sendable {
  static let shared = LaunchClock()

  private let lock = NSLock()
  private var launch: (at: Double, prewarmed: Bool)?
  private var sceneConnected = false
  private var taken = false

  /// Called once, from the app delegate's launch call.
  func launched(at: Double, prewarmed: Bool) {
    lock.withLock { launch = (at, prewarmed) }
  }

  /// A scene connected: the launch draws a window. Under the scene life
  /// cycle `applicationState` reads background in the launch call of every
  /// launch, since no scene is connected yet; a scene is what tells a
  /// tap's launch from a background task's (as `solunivo-background-launch`
  /// tells them apart).
  func connectedScene() {
    lock.withLock { sceneConnected = true }
  }

  /// The launch's start for its first reader, nil for any later one: a
  /// reload (PR Preview's Load) runs the bundle again in the same process,
  /// and its times would count from the process's start. Nil too for a
  /// launch without a scene when its JavaScript starts (a background
  /// task's), which draws nothing.
  func take() -> [String: Any]? {
    lock.withLock {
      defer { taken = true }
      guard !taken, sceneConnected, let launch else {
        return nil
      }
      if !launch.prewarmed, let start = Self.processStart() {
        return ["from": "process", "start": start]
      }
      return ["from": "launch", "start": launch.at]
    }
  }

  /// The process's start in milliseconds since 1970.
  private static func processStart() -> Double? {
    var info = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.stride
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
    guard sysctl(&mib, u_int(mib.count), &info, &size, nil, 0) == 0 else {
      return nil
    }
    let start = info.kp_proc.p_un.__p_starttime
    return Double(start.tv_sec) * 1000 + Double(start.tv_usec) / 1000
  }
}

public final class LaunchTimingAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    LaunchClock.shared.launched(
      at: Date().timeIntervalSince1970 * 1000,
      // iOS sets it in a process it started ahead of the launch.
      prewarmed: ProcessInfo.processInfo.environment["ActivePrewarm"] == "1"
    )
    // UIKit connects the launch's scene after this call returns, and the
    // scene starts React Native, so the flag is set before the bundle runs.
    sceneObserver = NotificationCenter.default.addObserver(
      forName: UIScene.willConnectNotification, object: nil, queue: nil
    ) { _ in
      LaunchClock.shared.connectedScene()
    }
    return false
  }

  private var sceneObserver: NSObjectProtocol?
}

public class SolunivoLaunchTimingModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SolunivoLaunchTiming")

    // Synchronous: the bundle reads it as it starts, before anything waits.
    Function("take") { () -> [String: Any]? in
      LaunchClock.shared.take()
    }
  }
}
