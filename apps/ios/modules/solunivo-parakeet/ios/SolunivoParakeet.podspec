require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'SolunivoParakeet'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = package['license']
  s.author         = package['author']
  s.homepage       = 'https://solunivo.com'
  s.platforms      = { :ios => '27.0' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # Pinned in the Podfile to a commit (plugins/withFluidAudioPod.cjs):
  # the releases on CocoaPods trunk stop at 0.7.8.
  s.dependency 'FluidAudio'

  # FluidAudio builds arm64 alone for the simulator (and leaves x86_64 out
  # of the app target): this pod has to match, or its x86_64 slice
  # imports a FluidAudio without one ("unsupported Swift architecture").
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'EXCLUDED_ARCHS[sdk=iphonesimulator*]' => 'i386 x86_64',
  }

  s.source_files = "**/*.{h,m,mm,swift}"
end
