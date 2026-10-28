// Dev entry only (`vp dev`): renders the route the browser is on. The
// production build never ships this file — see scripts/build.ts.
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './site.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('index.html has no #root.');
}
createRoot(root).render(<App path={window.location.pathname} />);
