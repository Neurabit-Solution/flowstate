# FlowState

Notices when you are in flow and protects it. Camera on only when you say so. Built on the Presage SmartSpectra SDK.

Status: M4 timeline. See `docs/SPEC.md` for the plan and `docs/DEVLOG.md` for progress.

## Run

Needs Node 20 or newer (24 LTS recommended). `npm install` downloads native runtimes for every platform, a few hundred MB.

```bash
npm install
cp .env.example .env   # then set PRESAGE_API_KEY
npm start
```

You can also paste the key during onboarding, which stores it in your OS keychain.

No key? Click **Use sample recording** during onboarding. It works without a key or a camera. The current samples are generated test data.

`npm start -- --demo` shortens the focus threshold to 30 s.

On Ubuntu 23.10 and newer, the first `npm start` stops with a Chromium sandbox error. FlowState keeps the sandbox on and prints the one command that fixes it:

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox && sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

Repeat it after any `npm install` that reinstalls Electron.

With that helper in use, Electron also cannot run from a path containing a space. Move the project, or keep it where it is and move only Electron:

```bash
mkdir -p ~/.cache/flowstate-electron && mv node_modules/electron/dist ~/.cache/flowstate-electron/dist && ln -s ~/.cache/flowstate-electron/dist node_modules/electron/dist
```

Scripts: `npm run dev` (rebuild on change, Ctrl+R to reload the window), `npm run lint`, `npm test`.

## Integrations and agents

Setup for Slack, Google Calendar and OS focus is in `docs/INTEGRATIONS.md`. **Coding agents** in the app gives you the setup command for Claude Code, Cursor and Copilot CLI, and `AGENTS-SNIPPET.md` has the rules to paste.

## Timeline

**Timeline** shows your states for the day with commits, test runs and agent messages on top, plus a week heatmap and patterns. It all stays in a local SQLite file for 30 days by default, and you can export or delete it. Add repos under **Timeline** to see commits. To record a test or build, wrap it with the command the Timeline panel shows.

## Platforms

macOS Apple Silicon, Linux x64 and arm64 (glibc 2.35+, so Ubuntu 22.04+ or Debian 12+), Windows x64. Intel Macs are not supported by the SDK. Not a medical device.
