import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

const root = document.getElementById('root');
if (root === null) throw new Error('@fitsgl/viewer: #root element is missing');

// No StrictMode here: this is the production viewer, not a test harness, and the
// dev double-mount would needlessly spin up the WebGL context twice.
createRoot(root).render(<App />);
