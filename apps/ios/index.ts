// First import, deliberately: installs the Web Crypto polyfill that shared
// code (event ids) needs before anything else is evaluated.
import './src/polyfills.ts';
// Defines the background task during evaluation, before any component
// mounts: iOS may launch the app just to run it.
import './src/backgroundTask.ts';
// Expo Router mounts the `app/` tree (`app/_layout.tsx` holds the providers).
import 'expo-router/entry';
