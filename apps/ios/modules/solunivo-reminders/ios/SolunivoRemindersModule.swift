import ExpoModulesCore

/// One generic entry point: the JS side speaks the same
/// `reminders.<method>` + params protocol as the macOS helper, and both
/// dispatch through RemindersDispatch (RemindersBridge.swift, shared).
/// `remindersChanged` mirrors the helper's id-less event line.
public class SolunivoRemindersModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SolunivoReminders")

    Events("remindersChanged")

    OnStartObserving {
      Task {
        await RemindersBridge.shared.observeChanges { [weak self] in
          self?.sendEvent("remindersChanged")
        }
      }
    }

    AsyncFunction("invoke") { (method: String, params: [String: Any]?) async throws -> [String: Any] in
      do {
        return try await RemindersDispatch.invoke(method: method, params: params ?? [:])
      } catch let error as RemindersBridgeError {
        // Same wire message as the helper, so the TS client maps it identically.
        throw Exception(name: "RemindersBridgeError", description: error.message)
      }
    }
  }
}
