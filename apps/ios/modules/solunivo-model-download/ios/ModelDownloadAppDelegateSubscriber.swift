import ExpoModulesCore
import UIKit

/// Hands iOS's background-session events to `ModelDownloadSession`: when a
/// transfer finishes while the app is suspended or not running, iOS
/// launches it in the background, and the session's delegate moves the
/// file into place before the completion handler is called. Events of
/// another module's session are answered at once: Expo waits for every
/// subscriber's answer before it answers iOS.
public final class ModelDownloadAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    handleEventsForBackgroundURLSession identifier: String,
    completionHandler: @escaping () -> Void
  ) {
    if !ModelDownloadSession.shared.handleEvents(for: identifier, completion: completionHandler) {
      completionHandler()
    }
  }
}
