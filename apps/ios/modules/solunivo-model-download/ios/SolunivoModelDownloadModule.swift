import ExpoModulesCore
import Foundation

/// The Assistant's model, fetched by iOS in the background
/// (`ModelDownloadSession`): on Wi-Fi without Low Data Mode, unless the
/// person allowed mobile data; on through suspension, and adopted again by
/// the next launch after the app was quit.
public class SolunivoModelDownloadModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SolunivoModelDownload")

    Events("onProgress", "onFinish", "onFail", "onPath")

    OnCreate { [weak self] in
      let module = WeakModule(self)
      ModelDownloadSession.shared.attach { name, body in
        module.value?.sendEvent(name, body)
      }
    }

    OnDestroy {
      ModelDownloadSession.shared.attach(nil)
    }

    // `network`: "wifi" (no mobile data, no Low Data Mode) or "any".
    AsyncFunction("start") { (url: String, destination: String, network: String, promise: Promise) in
      ModelDownloadSession.shared.start(
        url: url, destination: destination, network: Self.route(network)
      ) { result in
        promise.resolve(result)
      }
    }

    AsyncFunction("useNetwork") { (network: String, promise: Promise) in
      ModelDownloadSession.shared.use(network: Self.route(network)) { moved in
        promise.resolve(moved)
      }
    }

    AsyncFunction("cancel") { (destination: String, promise: Promise) in
      ModelDownloadSession.shared.cancel(destination: destination) {
        promise.resolve(nil)
      }
    }

    AsyncFunction("current") { (promise: Promise) in
      ModelDownloadSession.shared.current { state in
        promise.resolve(state)
      }
    }

    Function("path") { () -> [String: Bool] in
      ModelDownloadSession.shared.path()
    }
  }

  private static func route(_ network: String) -> ModelDownloadSession.Route {
    network == "any" ? .any : .wifi
  }
}

/// The module as the session's events reach it, from the session's queue:
/// held weakly, so the session does not keep a module JS let go.
private final class WeakModule: @unchecked Sendable {
  weak var value: SolunivoModelDownloadModule?

  init(_ value: SolunivoModelDownloadModule?) {
    self.value = value
  }
}
