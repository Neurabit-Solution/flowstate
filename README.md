# FlowState

Notices when you are in flow and protects it. It reads a live signal from your webcam using the [Presage SmartSpectra SDK](https://smartspectra.presagetech.com/docs/nodejs), turns it into one word (Focus, Available, In a conversation, Away), and then:

1. **Protects focus.** Sets Do Not Disturb, your Slack status and a calendar block, and puts them back afterwards.
2. **Tells your coding agents to wait.** A local MCP server lets Claude Code, Cursor and Copilot CLI hold non-urgent questions.
3. **Shows you your own patterns.** A private timeline of focus blocks with your commits and test runs on top.

The camera is off until you click. Video is processed on your computer and never saved. Not a medical device. Details: [docs/DATA-HANDLING.md](docs/DATA-HANDLING.md).

The live SDK code is in [`src/signals/sdk-session.ts`](src/signals/sdk-session.ts).

## Try it without a key or camera

Needs Node 20 or newer (24 recommended). `npm install` downloads native runtimes for every platform, a few hundred MB.

```bash
git clone https://github.com/Neurabit-Solution/flowstate.git
```
```bash
cd flowstate && npm install && npm start
```

In onboarding, go to the API key step and click **Use sample recording**. It feeds recorded metrics (never video) through the same pipeline and is labelled "Sample recording (not live)" on screen. It plays at 20x speed. Open **Timeline** and **Integrations** to see what it did. Samples log what integrations would do, and change nothing.

The current samples are generated test data, and the app says so.

## Use the camera

Get an API key at https://physiology.presagetech.com/auth/register, then paste it during onboarding. It is stored in your OS keychain. For development you can instead copy `.env.example` to `.env`.

For good readings:

- Keep your head and upper chest in frame.
- Use good light. The SDK needs about 25 frames a second and stops below that, and webcams slow down in the dark. **Show live signal** shows the camera's speed.
- If you have several cameras, pick one on the home screen.

`npm start -- --demo` shortens the time to focus to 30 s.

## Platforms

| | |
|---|---|
| Windows | x64 |
| macOS | Apple Silicon only. The SDK does not support Intel Macs. |
| Linux | x64 and arm64 from source, with glibc 2.35+ (Ubuntu 22.04+, Debian 12+). Installers are x64. |

Installers are on the [releases page](https://github.com/Neurabit-Solution/flowstate/releases) once published. They are not code signed yet, so macOS and Windows will warn you.

### Ubuntu 23.10 and newer

Ubuntu restricts the sandbox Electron relies on. FlowState keeps the sandbox on rather than running without it.

- **Installed:** use the `.deb`, which sets this up when it installs. The AppImage cannot do this, and stops at launch with a sandbox error.
- **From source:** the first `npm start` stops and prints the command to run:

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox && sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

Repeat it after any `npm install` that reinstalls Electron. Electron also cannot run from a path with a space in this setup. Move the project, or move only Electron:

```bash
mkdir -p ~/.cache/flowstate-electron && mv node_modules/electron/dist ~/.cache/flowstate-electron/dist && ln -s ~/.cache/flowstate-electron/dist node_modules/electron/dist
```

## Integrations and agents

All are off until you turn them on. Setup for Slack, Google Calendar and OS focus is in [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md). **Coding agents** in the app gives you the setup command for your agent, and [AGENTS-SNIPPET.md](AGENTS-SNIPPET.md) has the rules to paste.

## Timeline

Add repos under **Timeline** to see commits and branch switches. To record a test or build, wrap it with the command that panel shows. It stays in a local SQLite file for 30 days by default, and you can export or delete it.

## Development

```bash
npm run dev
```
```bash
npm run lint && npm test
```

`npm run dist:linux`, `dist:mac` and `dist:win` build installers for the system you are on. Pushing a tag like `v0.1.0` builds all three in GitHub Actions and attaches them to a draft release.

Signals flow one way: `signals -> state -> (integrations | mcp | timeline)`. Raw values stay in `src/signals/`, and tests enforce this.
