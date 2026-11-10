import {createRoot} from 'react-dom/client';
import {registerSW} from 'virtual:pwa-register';
import App from './App.tsx';
import './index.css';

// Register Service Worker for offline static asset caching
registerSW({immediate: true});

createRoot(document.getElementById('root')!).render(<App />);
