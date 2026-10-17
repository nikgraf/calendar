import ExpoModulesCore

#if canImport(FoundationModels)
  import FoundationModels
#endif

/// Why Apple's on-device model can or cannot run, read from Foundation
/// Models itself. `@react-native-ai/apple`, which does the generating,
/// answers only a boolean — the quick-add notice could not say whether to
/// switch Apple Intelligence on, wait for it, or stop looking. The reason
/// is stringified the way the desktop helper's `handleStatus` does it, so
/// both hosts map through one table (`APPLE_REASON_STATUS` in packages/ai).
public class SolunivoModelAvailabilityModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SolunivoModelAvailability")

    // Async, so it runs off the JS thread and the caller can bound it.
    AsyncFunction("check") { () -> [String: String] in
      #if canImport(FoundationModels)
        if #available(iOS 26, *) {
          switch SystemLanguageModel.default.availability {
          case .available:
            return ["status": "available"]
          case .unavailable(let reason):
            return ["reason": String(describing: reason), "status": "unavailable"]
          @unknown default:
            return ["status": "unavailable"]
          }
        }
      #endif
      return ["reason": "osTooOld", "status": "unavailable"]
    }
  }
}
