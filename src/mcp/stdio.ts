// Entry point for agents that launch Pulse themselves. Stdout belongs to the MCP protocol.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RemoteBackend } from './remote';
import { createPulseServer, RESOURCE_URI } from './tools';

const POLL_MS = 5000;

function defaultConnectionFile(): string {
  const home = homedir();
  const name = 'flowstate';
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', name, 'pulse.json');
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), name, 'pulse.json');
  return join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), name, 'pulse.json');
}

async function main(): Promise<void> {
  const backend = new RemoteBackend(process.env.FLOWSTATE_PULSE_FILE ?? defaultConnectionFile());
  const pulse = createPulseServer(backend, '0.0.1');
  await pulse.server.connect(new StdioServerTransport());

  // No channel back from the app here, so subscribers hear about changes by polling.
  let last = (await backend.getDevState()).state;
  const timer = setInterval(() => {
    void backend.getDevState().then(({ state }) => {
      if (state !== last) {
        last = state;
        if (pulse.subscribed()) void pulse.server.server.sendResourceUpdated({ uri: RESOURCE_URI }).catch(() => undefined);
      }
    });
  }, POLL_MS);
  timer.unref();
}

main().catch((err) => {
  console.error('[flowstate-pulse]', err);
  process.exit(1);
});
