#import "SolunivoReactHost.h"

#import <React/RCTDevMenu.h>

void SolunivoStartReactHost(RCTReactNativeFactory *factory, RCTBundleConfiguration *bundleConfiguration)
{
  // As `-[EXReactRootViewFactory superViewWithModuleName:…]` fills it in.
  RCTDevMenuConfiguration *devMenuConfiguration =
      factory.devMenuConfiguration ?: [RCTDevMenuConfiguration defaultConfiguration];
  [factory.rootViewFactory initializeReactHostWithLaunchOptions:nil
                                            bundleConfiguration:bundleConfiguration
                                           devMenuConfiguration:devMenuConfiguration];
}
