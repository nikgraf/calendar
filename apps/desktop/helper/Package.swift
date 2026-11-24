// swift-tools-version: 6.4
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
  // The app needs macOS 27 (LSMinimumSystemVersion in forge.config.cjs), so
  // the helper's floor is the same: Foundation Models, SpeechAnalyzer and
  // the rest link normally and no code path is guarded by OS version.
  // Building needs Xcode 27 (the macOS 27 SDK; `.v27` is swift-tools 6.4).
  platforms: [.macOS(.v27)],
  dependencies: [
    // Parakeet (ParakeetBridge.swift), at the commit the measurements ran
    // (#378), as the iOS Podfile pins it (apps/ios/plugins/withFluidAudioPod.cjs).
    .package(
      url: "https://github.com/FluidInference/FluidAudio.git",
      revision: "eb280cede001a9a35f2187d4a117537777eca756")
  ],
  targets: [
    .executableTarget(
      name: "solunivo-model-helper",
      dependencies: [.product(name: "FluidAudio", package: "FluidAudio")],
      exclude: ["Info.plist"],
      linkerSettings: [
        .unsafeFlags([
          "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist",
          "-Xlinker", infoPlist,
        ]),
      ]
    )
  ]
)
