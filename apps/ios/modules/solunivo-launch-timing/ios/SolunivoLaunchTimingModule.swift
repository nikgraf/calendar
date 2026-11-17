import ExpoModulesCore
import Foundation
import UIKit

/// When each launch began, for the launch times Settings › Advanced ›
/// Diagnostics shows. JavaScript can't see the time before its bundle
/// runs: React Native's start and the bundle's load happen first (and
/// React Native's own startup marker is set only after them), and a
/// launch can hang there.
///
/// A launch starts with its process, read from the kernel. A process that
/// was running before the tap (prewarmed by iOS, or woken in the
/// background and suspended) starts when its window's scene connects.
/// That start is kept in the user defaults until the launch's JavaScript
/// takes it, so launches closed before their JavaScript ran are found by
/// the next one that gets that far.
final class LaunchClock: @unchecked Sendable {
  static let shared = LaunchClock()

  private static let pendingKey = "SolunivoLaunchTiming.pending"
  /// A scene connects tens of milliseconds after UIKit's launch call on a
  /// tap; one that connects later joined a process that was already there.
  private static let promptSceneMs: Double = 5000

  private let lock = NSLock()
  private var launchedAt: Double?
  private var prewarmed = false
  /// This launch's start, once its first scene connected.
  private var current: Double?
  private var taken = false

  /// Called once, from the app delegate's launch call.
  func launched(at: Double, prewarmed: Bool) {
    lock.withLock {
      launchedAt = at
      self.prewarmed = prewarmed
    }
  }

  /// A scene connected: the launch draws a window. Only the process's
  /// first counts, and none after its JavaScript ran (a background task's
  /// run that the user then opened draws no launch of its own).
  func connectedScene(at now: Double) {
    lock.withLock {
      guard current == nil, !taken else {
        return
      }
      var start = now
      if !prewarmed, let launchedAt, now - launchedAt < Self.promptSceneMs,
        let processStart = Self.processStart()
      {
        start = processStart
      }
      current = start
      let pending = Self.pending() + [start]
      UserDefaults.standard.set(Array(pending.suffix(Self.keptPending)), forKey: Self.pendingKey)
    }
  }

  /// For the launch's first reader: its start once a scene connected
  /// (`start`), and the earlier launches that never reached their
  /// JavaScript, oldest first (`unfinished`; a background launch finds them
  /// too). Empty for any later reader, since a reload (PR Preview's Load)
  /// runs the bundle again in the same process.
  func take() -> [String: Any] {
    lock.withLock {
      guard !taken else {
        return [:]
      }
      taken = true
      let unfinished = Self.pending().filter { $0 != current }
      UserDefaults.standard.removeObject(forKey: Self.pendingKey)
      var result: [String: Any] = ["unfinished": unfinished]
      if let current {
        result["start"] = current
      }
      return result
    }
  }

  /// How many unfinished launches wait at most.
  private static let keptPending = 10

  private static func pending() -> [Double] {
    UserDefaults.standard.array(forKey: pendingKey) as? [Double] ?? []
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

private func nowMs() -> Double {
  Date().timeIntervalSince1970 * 1000
}

public final class LaunchTimingAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    LaunchClock.shared.launched(
      at: nowMs(),
      // iOS sets it in a process it started ahead of the launch.
      prewarmed: ProcessInfo.processInfo.environment["ActivePrewarm"] == "1"
    )
    // UIKit connects the launch's scene after this call returns, and the
    // scene starts React Native, so the start is set before the bundle runs.
    sceneObserver = NotificationCenter.default.addObserver(
      forName: UIScene.willConnectNotification, object: nil, queue: nil
    ) { _ in
      LaunchClock.shared.connectedScene(at: nowMs())
    }
    return false
  }

  private var sceneObserver: NSObjectProtocol?
}

public class SolunivoLaunchTimingModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SolunivoLaunchTiming")

    // Synchronous: the bundle reads it as it starts, before anything waits.
    Function("take") { () -> [String: Any] in
      LaunchClock.shared.take()
    }
  }
}
