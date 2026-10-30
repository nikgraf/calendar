// Dev entry only (`vp dev`): renders the route the browser is on. The
// production build never ships this file — see scripts/build.ts, which
// inlines the theme script into <head>; here it loads as a module and
// applies once more on `load`, after React has mounted the controls.
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './inline/theme.js';
import './site.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('index.html has no #root.');
}
createRoot(root).render(<App path={window.location.pathname} />);
