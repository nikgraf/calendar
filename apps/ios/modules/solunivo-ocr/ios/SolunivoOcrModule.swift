import ExpoModulesCore

/// One generic entry point: the JS side speaks the same `ocr.<method>` +
/// params protocol as the macOS helper, and both dispatch through
/// OcrDispatch (OcrBridge.swift, shared).
public class SolunivoOcrModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SolunivoOcr")

    AsyncFunction("invoke") { (method: String, params: [String: Any]?) async throws -> [String: Any] in
      do {
        return try await OcrDispatch.invoke(method: method, params: params ?? [:])
      } catch let error as OcrBridgeError {
        // Same wire message as the helper, so the TS client maps it identically.
        throw Exception(name: "OcrBridgeError", description: error.message)
      }
    }
  }
}
