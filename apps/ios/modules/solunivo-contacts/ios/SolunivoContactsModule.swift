import ExpoModulesCore

/// One generic entry point: the JS side speaks the same
/// `contacts.<method>` + params protocol as the macOS helper, and both
/// dispatch through ContactsDispatch (ContactsBridge.swift, shared).
/// `contactsChanged` mirrors the helper's id-less event line.
public class SolunivoContactsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SolunivoContacts")

    Events("contactsChanged")

    OnStartObserving {
      Task {
        await ContactsBridge.shared.observeChanges { [weak self] in
          self?.sendEvent("contactsChanged")
        }
      }
    }

    AsyncFunction("invoke") { (method: String, params: [String: Any]?) async throws -> [String: Any] in
      do {
        return try await ContactsDispatch.invoke(method: method, params: params ?? [:])
      } catch let error as ContactsBridgeError {
        // Same wire message as the helper, so the TS client maps it identically.
        throw Exception(name: "ContactsBridgeError", description: error.message)
      }
    }
  }
}
