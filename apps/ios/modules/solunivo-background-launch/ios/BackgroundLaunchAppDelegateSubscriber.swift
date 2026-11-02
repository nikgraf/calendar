import EXUpdates
import Expo
import ExpoModulesCore
import React
import os

private let logger = Logger(subsystem: "com.solunivo.app", category: "BackgroundLaunch")

/// Starts React Native without a window when iOS launches the app and
/// connects no scene — for this app, a BGProcessingTask run of
/// `src/backgroundTask.ts` after the app was terminated.
///
/// Under the scene life cycle (Expo SDK 58) only
/// `ExpoAppSceneDelegate.scene(_:willConnectTo:)` starts React Native, so
/// such a launch ran no JavaScript: expo-task-manager queued the task's
/// event for a task manager that never registered, and iOS ended the task
/// unrun. Here the React host starts the way a scene starts it, minus the
/// view — after expo-updates' launch, which picks the bundle, so an OTA
/// update runs in the background too. Evaluating the bundle defines the
/// task, and expo-task-manager hands it the queued event.
///
/// A scene that connects later starts React Native the usual way; the root
/// view factory finds the running host and only adds the app's surface to
/// it, so the scene takes over this runtime instead of starting a second
/// app. That runtime started without the scene's launch options, so
/// `Linking.getInitialURL()` is null then; the share extension's hand-off
/// does not depend on its URL (the calendar takes the share from the app
/// group when it mounts).
///
/// Debug builds are left alone: the dev launcher picks their bundle and
/// needs a window to do it.
public final class BackgroundLaunchAppDelegateSubscriber: ExpoAppDelegateSubscriber, AppControllerDelegate {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    // UIKit connects a launch's scene after this call returns, as an event
    // of its own (tens of milliseconds later on a simulator), so only after a
    // while does no scene mean a background launch. A foreground launch
    // must be left to its scene: the scene's launch options carry the link
    // that opened the app.
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.sceneGrace) {
      self.startIfNoScene()
    }
    return false
  }

  /// Far above the scene's delay, far below a background task's minutes.
  private static let sceneGrace: DispatchTimeInterval = .seconds(2)

  private func startIfNoScene() {
    guard !EXAppDefines.APP_DEBUG,
      UIApplication.shared.connectedScenes.isEmpty,
      let factory = Self.factory,
      !Self.hasHost(factory)
    else {
      return
    }
    AppController.initializeWithoutStarting()
    let controller = AppController.sharedInstance
    if !controller.isActiveController {
      // expo-updates is off: the app delegate's embedded bundle, as on a
      // scene's start.
      startHost(factory, bundleURL: nil)
    } else if !controller.isStarted {
      // Started already only by a scene that has gone again; its own start
      // finishes then.
      controller.delegate = self
      controller.start()
    }
  }

  // Called on the main queue once expo-updates has picked the bundle.
  public nonisolated func appController(
    _ appController: AppControllerInterface,
    didStartWithSuccess success: Bool
  ) {
    MainActor.assumeIsolated {
      guard let factory = Self.factory, !Self.hasHost(factory) else {
        // A scene connected after the launch finished and started the app.
        return
      }
      if UIApplication.shared.connectedScenes.isEmpty {
        startHost(factory, bundleURL: AppController.sharedInstance.launchAssetUrl())
        return
      }
      // A scene connected while the launch was still running. expo-updates'
      // handler then put up its placeholder view and waits for this call,
      // which `start()` above routed here instead; it starts the app into
      // the scene's window, with the scene's launch options.
      logger.notice("A scene connected during the background launch; handing over to expo-updates")
      ExpoAppDelegateSubscriberRepository.reactDelegateHandlers.lazy
        .compactMap { $0 as? ExpoUpdatesReactDelegateHandler }
        .first?
        .appController(appController, didStartWithSuccess: success)
    }
  }

  private func startHost(_ factory: RCTReactNativeFactory, bundleURL: URL?) {
    logger.notice("No scene connected: starting React Native without a window")
    // What expo-updates' handler passes when it starts the app for a scene
    // (`recreateRootView`); the bundle itself comes from the root view
    // factory's `bundleURL`, which asks expo-updates.
    SolunivoStartReactHost(factory, ExpoBundleConfiguration.configuration(bundleURL: bundleURL))
  }

  private static var factory: RCTReactNativeFactory? {
    (UIApplication.shared.delegate as? ExpoReactNativeFactoryProvider)?.reactNativeFactory
  }

  // `reactHost` is declared with a forward-declared class, which Swift does
  // not import.
  private static func hasHost(_ factory: RCTReactNativeFactory) -> Bool {
    factory.rootViewFactory.value(forKey: "reactHost") != nil
  }
}
