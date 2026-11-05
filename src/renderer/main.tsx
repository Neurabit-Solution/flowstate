import { createRoot } from 'react-dom/client';
import type { FlowstateBridge } from '../shared/types';
import { SignalHost } from '../signals/host';
import { App } from './App';
import './styles.css';

declare global {
  interface Window {
    flowstate: FlowstateBridge;
    flowstateDemo: boolean;
  }
}

// One host for the life of the page. Creating it does not touch the camera.
const host = new SignalHost(window.flowstate, window.flowstateDemo);
window.addEventListener('beforeunload', () => {
  void host.stopSensing();
});

const root = document.getElementById('root');
if (root) createRoot(root).render(<App host={host} />);
