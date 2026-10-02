import { createRoot } from 'react-dom/client';
import { App, SettingsApp } from './App.tsx';
import { isSettingsRoute } from './settingsPanes.ts';
import './App.css';

// One bundle, two windows: the main process loads the settings window at
// `#settings` (windows.ts); everything else is the calendar.
createRoot(document.querySelector('#root')!).render(
  isSettingsRoute(window.location.hash) ? <SettingsApp /> : <App />,
);
