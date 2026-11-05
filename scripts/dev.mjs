// Dev loop: rebuilds on change, then launches the app. Press Ctrl+R in the window
// to pick up renderer changes; restart for main or preload changes.
import { spawn, spawnSync } from 'node:child_process';

const opts = { stdio: 'inherit', shell: process.platform === 'win32' };
const first = spawnSync('node', ['scripts/build.mjs'], opts);
if (first.status !== 0) process.exit(first.status ?? 1);

const children = [
  spawn('node', ['scripts/build.mjs', '--watch'], opts),
  spawn('npx', ['vite', 'build', '--watch', '--logLevel', 'warn'], opts),
];
const app = spawn('node', ['scripts/launch.mjs'], opts);
app.on('exit', (code) => {
  for (const child of children) child.kill();
  process.exit(code ?? 0);
});
