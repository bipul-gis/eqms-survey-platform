import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Capacitor injects `window.Capacitor` in the native shell (no npm import needed).
const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } })
  .Capacitor;
if (cap?.isNativePlatform?.()) {
  document.documentElement.classList.add('capacitor-native');
}

if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.getRegistrations().then((registrations) => {
    registrations.forEach((registration) => void registration.update());
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
