// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "solunivo-model-helper",
  // The executable runs on any modern macOS and reports the model
  // unavailable below 26; only the guarded code paths need the new SDK.
  platforms: [.macOS(.v14)],
  targets: [
    .executableTarget(
      name: "solunivo-model-helper",
      linkerSettings: [
        // Weak-link so launching on macOS < 26 does not dyld-abort.
        .unsafeFlags(["-Xlinker", "-weak_framework", "-Xlinker", "FoundationModels"]),
        .unsafeFlags(["-Xlinker", "-weak_framework", "-Xlinker", "Speech"]),
      ]
    )
  ]
)
