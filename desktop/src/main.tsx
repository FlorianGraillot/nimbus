import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initAppearance } from './lib/theme';
import './styles.css';

initAppearance();

if (window.nimbus?.isElectron) {
  document.documentElement.classList.add('is-electron');
}

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
