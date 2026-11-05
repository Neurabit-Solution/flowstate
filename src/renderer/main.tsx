import { createRoot } from 'react-dom/client';
import { DebugPanel, type SignalBridge } from '../signals/debug-panel';
import './styles.css';

declare global {
  interface Window {
    flowstate: SignalBridge;
  }
}

function App() {
  return (
    <main>
      <h1>FlowState</h1>
      <p className="lede">Debug screen. The full consent flow and tray arrive in the next milestone.</p>
      <ul className="consent">
        <li>The camera stays off until you click Turn on camera, and it stops by itself after 15 minutes.</li>
        <li>Video frames are processed on this computer. They are never saved or uploaded.</li>
        <li>The SDK contacts Presage to validate the API key. SDK telemetry is off.</li>
        <li>Metrics are saved only if you tick the box, to a local file you can delete.</li>
        <li>Not a medical device.</li>
      </ul>
      <DebugPanel bridge={window.flowstate} />
    </main>
  );
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
