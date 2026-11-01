import { getLinkingURL } from 'expo-linking';
import { Linking } from 'react-native';

/**
 * The URL that brought the app up, if any. Usually React Native's launch
 * URL. After a background refresh started React Native without a scene
 * (`modules/solunivo-background-launch`), the scene that opens the app
 * joins that runtime: its launch options held no URL, and the scene's `url`
 * event fired before any listener was mounted. expo-linking keeps the last
 * URL the app was opened with, so a settings code from the Camera app is
 * still read then.
 */
export const launchUrl = async (): Promise<string | null> =>
  (await Linking.getInitialURL()) ?? getLinkingURL();
