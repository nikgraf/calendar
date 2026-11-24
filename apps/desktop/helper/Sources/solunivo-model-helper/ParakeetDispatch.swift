import Foundation

/// The helper's `parakeet.*` methods over ParakeetBridge.swift (shared with
/// the iOS Expo module): Electron main keeps the state (when to download,
/// whether dictation reads with it), the helper the files and the model.
/// `folder` comes with every call: the Mac app's profile holds the files,
/// and each variant has its own.
enum ParakeetDispatch {
  private static let downloads = HelperParakeetDownloads()

  static func invoke(method: String, params: [String: JSONValue]) async throws -> [String: Any] {
    guard let folder = params["folder"]?.stringValue, !folder.isEmpty else {
      throw HelperError.badRequest("folder required")
    }
    await ParakeetEngine.shared.configure(folder: URL(fileURLWithPath: folder, isDirectory: true))
    switch method {
    case "parakeet.state":
      return await ParakeetEngine.shared.state().json
    case "parakeet.download":
      // Progress goes out as `parakeet.progress` events while it runs.
      try await downloads.start {
        try await ParakeetEngine.shared.download { fraction in
          emit(["event": "parakeet.progress", "fraction": fraction])
        }
      }.value
      return [:]
    case "parakeet.cancel":
      downloads.cancel()
      return [:]
    case "parakeet.remove":
      downloads.cancel()
      try await ParakeetEngine.shared.remove()
      return [:]
    case "parakeet.use":
      let on: Bool
      if case .bool(let value)? = params["on"] { on = value } else { on = false }
      var vocabulary: [String] = []
      if case .array(let values)? = params["vocabulary"] {
        vocabulary = values.compactMap(\.stringValue)
      }
      await ParakeetEngine.shared.use(on: on, vocabulary: vocabulary)
      return [:]
    default:
      throw HelperError.badRequest("unknown method \(method)")
    }
  }
}

/// The one Parakeet download at a time: a second call joins it, a cancel stops it.
private final class HelperParakeetDownloads: @unchecked Sendable {
  private let lock = NSLock()
  private var current: Task<Void, Error>?

  func start(_ work: @escaping @Sendable () async throws -> Void) -> Task<Void, Error> {
    lock.withLock {
      if let current { return current }
      let task = Task {
        defer { self.finished() }
        try await work()
      }
      current = task
      return task
    }
  }

  private func finished() {
    lock.withLock { current = nil }
  }

  func cancel() {
    lock.withLock {
      current?.cancel()
      current = nil
    }
  }
}
