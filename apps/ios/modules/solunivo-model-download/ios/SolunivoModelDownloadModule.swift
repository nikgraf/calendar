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

    OnCreate {
      ModelDownloadSession.shared.attach { [weak self] name, body in
        self?.sendEvent(name, body)
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
