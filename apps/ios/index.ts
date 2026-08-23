// First import, deliberately: installs the Web Crypto polyfill that shared
// code (event ids) needs before anything else is evaluated.
import './src/polyfills.ts';
import { registerRootComponent } from 'expo';
import { App } from './App.tsx';

registerRootComponent(App);
