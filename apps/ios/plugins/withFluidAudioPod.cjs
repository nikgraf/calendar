// FluidAudio (the Speech Spike page's Parakeet, modules/solunivo-parakeet)
// is pinned here to the commit the Mac measurements ran (2026-11-23): its
// releases on CocoaPods trunk stop at 0.7.8, far behind the podspec in
// its repository, so the pod comes from git. Written into the Podfile, so a
// local build, EAS and CI all get the same one.
const { withPodfile } = require('expo/config-plugins');

const LINE =
  "  pod 'FluidAudio', :git => 'https://github.com/FluidInference/FluidAudio.git', :commit => 'eb280cede001a9a35f2187d4a117537777eca756'";
const ANCHOR = 'use_expo_modules!';

module.exports = (config) =>
  withPodfile(config, (podfile) => {
    const { contents } = podfile.modResults;
    if (!contents.includes("pod 'FluidAudio'")) {
      if (!contents.includes(ANCHOR)) {
        throw new Error(
          `withFluidAudioPod: no "${ANCHOR}" line in the Podfile to add the pod after`,
        );
      }
      podfile.modResults.contents = contents.replace(
        ANCHOR,
        `${ANCHOR}\n  # FluidAudio from git, pinned (plugins/withFluidAudioPod.cjs).\n${LINE}`,
      );
    }
    return podfile;
  });
