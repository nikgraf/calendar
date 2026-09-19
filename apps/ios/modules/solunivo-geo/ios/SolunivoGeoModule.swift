import ExpoModulesCore

/// One generic entry point: the JS side speaks the same `geo.<method>` +
/// params protocol as the macOS helper, and both dispatch through
/// GeoDispatch (GeoBridge.swift, shared).
public class SolunivoGeoModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SolunivoGeo")

    AsyncFunction("invoke") { (method: String, params: [String: Any]?) async throws -> [String: Any] in
      do {
        return try await GeoDispatch.invoke(method: method, params: params ?? [:])
      } catch let error as GeoBridgeError {
        // Same wire message as the helper, so the TS client maps it identically.
        throw Exception(name: "GeoBridgeError", description: error.message)
      }
    }
  }
}
