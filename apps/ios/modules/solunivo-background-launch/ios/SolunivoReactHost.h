#import <Foundation/Foundation.h>
#import <Expo/RCTAppDelegateUmbrella.h>
#import <React/RCTBundleManager.h>

NS_ASSUME_NONNULL_BEGIN

/// Starts the factory's React host without a surface, with the dev menu
/// configuration a scene's start passes. Objective-C because in a release
/// build that configuration is nil, which Swift cannot pass for the nonnull
/// parameter React Native declares.
FOUNDATION_EXPORT void SolunivoStartReactHost(
    RCTReactNativeFactory *factory,
    RCTBundleConfiguration *bundleConfiguration);

NS_ASSUME_NONNULL_END
