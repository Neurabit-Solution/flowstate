// Launches Electron. VS Code terminals export ELECTRON_RUN_AS_NODE=1, which makes
// Electron run as plain Node and exit at once, so it is cleared here.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const electron = require('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, ['.', ...process.argv.slice(2)], { stdio: ['inherit', 'inherit', 'pipe'], env });

let sandboxFailed = false;
child.stderr.on('data', (chunk) => {
  process.stderr.write(chunk);
  if (String(chunk).includes('setuid_sandbox_host')) sandboxFailed = true;
});

child.on('exit', (code, signal) => {
  if (sandboxFailed) {
    const helper = join(dirname(electron), 'chrome-sandbox');
    console.error(`
FlowState could not start: this Linux blocks the sandbox Electron normally uses (Ubuntu 23.10 and newer do this).
FlowState keeps the sandbox on rather than running without it. To allow it for this copy of Electron, run:

  sudo chown root:root "${helper}" && sudo chmod 4755 "${helper}"

Then run npm start again. Repeat this after any npm install that reinstalls Electron.
`);
  }
  process.exit(code ?? (signal ? 1 : 0));
});
