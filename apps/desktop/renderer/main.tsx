import { createRoot } from 'react-dom/client';
import { App, SettingsApp } from './App.tsx';
import { isSettingsRoute } from './settingsPanes.ts';
import { applyThemeAttribute } from './theme.ts';
import './App.css';

// Before the first paint, so the tokens resolve for the right appearance.
applyThemeAttribute();

// One bundle, two windows: the main process loads the settings window at
// `#settings` (windows.ts); everything else is the calendar.
createRoot(document.querySelector('#root')!).render(
  isSettingsRoute(window.location.hash) ? <SettingsApp /> : <App />,
);
