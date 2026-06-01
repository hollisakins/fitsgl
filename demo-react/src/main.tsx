import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

const root = document.getElementById('root');
if (root === null) throw new Error('demo-react: #root element is missing');

// StrictMode on purpose: it double-invokes effects in dev, so the harness also
// exercises the <FitsViewer> mount→unmount→mount teardown path for real.
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
