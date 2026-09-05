// swift-tools-version: 6.0
import Foundation
import PackageDescription

// The helper is a bare executable, not a bundle, so its usage descriptions
// (Reminders access) ride inside the Mach-O as an embedded Info.plist —
// the standard arrangement for command-line tools that touch TCC-guarded
// data. Absolute path: the linker's cwd is not the package root.
let infoPlist = URL(fileURLWithPath: #filePath)
  .deletingLastPathComponent()
  .appendingPathComponent("Sources/solunivo-model-helper/Info.plist")
  .path

let package = Package(
  name: "solunivo-model-helper",
  // The executable runs on any modern macOS and reports the model
  // unavailable below 26; only the guarded code paths need the new SDK.
  platforms: [.macOS(.v14)],
  targets: [
    .executableTarget(
      name: "solunivo-model-helper",
      exclude: ["Info.plist"],
      linkerSettings: [
        // Weak-link so launching on macOS < 26 does not dyld-abort.
        .unsafeFlags(["-Xlinker", "-weak_framework", "-Xlinker", "FoundationModels"]),
        .unsafeFlags(["-Xlinker", "-weak_framework", "-Xlinker", "Speech"]),
        .unsafeFlags([
          "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist",
          "-Xlinker", infoPlist,
        ]),
      ]
    )
  ]
)
