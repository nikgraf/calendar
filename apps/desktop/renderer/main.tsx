import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './App.css';

createRoot(document.querySelector('#root')!).render(<App />);
