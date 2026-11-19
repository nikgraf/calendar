// llama.rn's pod links a prebuilt llama.cpp framework that the package's
// postinstall downloads from a GitHub release. This workspace runs no
// install scripts (pnpm-workspace.yaml, `allowBuilds`), so the framework
// is never there; the pod compiles the sources the npm package ships
// when this variable is set while CocoaPods reads the podspec. Written
// into the Podfile, so a local build, EAS and CI all get it, and no
// script or profile has to remember it.
const { withPodfile } = require('expo/config-plugins');

const LINE = "ENV['RNLLAMA_BUILD_FROM_SOURCE'] = '1'";

module.exports = (config) =>
  withPodfile(config, (podfile) => {
    if (!podfile.modResults.contents.includes(LINE)) {
      podfile.modResults.contents = `# llama.rn compiles from its vendored sources (plugins/withLlamaFromSource.cjs).\n${LINE}\n${podfile.modResults.contents}`;
    }
    return podfile;
  });
