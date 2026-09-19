import ExpoModulesCore

/// One generic entry point: the JS side speaks the same `calendar.<method>`
/// + params protocol as the macOS helper, and both dispatch through
/// AppleCalendarDispatch (AppleCalendarBridge.swift, shared).
/// `calendarChanged` mirrors the helper's id-less event line.
public class SolunivoAppleCalendarModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SolunivoAppleCalendar")

    Events("calendarChanged")

    OnStartObserving {
      Task {
        await AppleCalendarBridge.shared.observeChanges { [weak self] in
          self?.sendEvent("calendarChanged")
        }
      }
    }

    AsyncFunction("invoke") { (method: String, params: [String: Any]?) async throws -> [String: Any] in
      do {
        return try await AppleCalendarDispatch.invoke(method: method, params: params ?? [:])
      } catch let error as AppleCalendarBridgeError {
        // Same wire message as the helper, so the TS client maps it identically.
        throw Exception(name: "AppleCalendarBridgeError", description: error.message)
      }
    }
  }
}
