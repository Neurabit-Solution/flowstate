// Builds main and preload with esbuild, and the renderer with Vite.
import { spawnSync } from 'node:child_process';
import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');

const shared = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: true,
  logLevel: 'warning',
};

const configs = [
  {
    ...shared,
    // The flowstate run command. Reports when commands ran, never their output.
    entryPoints: ['src/cli/run.ts'],
    outfile: 'dist/cli/run.js',
  },
  {
    ...shared,
    // Started by coding agents, not by the app. Reads DevState only.
    entryPoints: ['src/mcp/stdio.ts'],
    outfile: 'dist/mcp/stdio.js',
  },
  {
    ...shared,
    entryPoints: ['src/main/index.ts'],
    outfile: 'dist/main/index.js',
    // The SDK loads native libraries relative to its own package, so it stays external.
    external: ['electron', '@smartspectra/node-sdk', '@smartspectra/node-sdk/*'],
  },
  {
    ...shared,
    // Bundled because a sandboxed preload cannot require from node_modules.
    entryPoints: ['src/preload/index.ts'],
    outfile: 'dist/preload/index.js',
    external: ['electron'],
  },
];

if (watch) {
  for (const config of configs) {
    const ctx = await context(config);
    await ctx.watch();
  }
} else {
  await Promise.all(configs.map((config) => build(config)));
  const vite = spawnSync('npx', ['vite', 'build', '--logLevel', 'warn'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  process.exit(vite.status ?? 1);
}
