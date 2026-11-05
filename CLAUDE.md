# FlowState: project brief for Claude Code

## What this is
FlowState is a cross-platform desktop app (Windows, Linux, macOS) for developers. It uses the Presage SmartSpectra SDK to read live human signals from the webcam and turns them into a simple local "dev state" (focused / available / talking / away). It then:

1. **Protects focus** (tray app): when the user is in sustained focus, it sets Do Not Disturb across Slack, Teams, Discord and the OS, and blocks time on Google Calendar. When the user leaves or starts talking, everything is restored.
2. **Pulse MCP** (agent awareness): a local MCP server that exposes the dev state to coding agents (Claude Code, Cursor, Copilot CLI) so they hold non-urgent questions while the user is focused and summarize when they return.
3. **Dev Day Replay** (private timeline): a local timeline of focus blocks laid over git commits, test runs and CI events, so the user can see when they focus best and what breaks it.

Entry for the DEV.to **Presage SmartSpectra SDK Challenge**.
- Challenge: https://dev.to/challenges/presage-2026-11-04
- **Submission deadline: 22 Nov 2026, 11:59 PM PST (about 1:29 PM IST on 23 Nov). Target code-freeze 19 Nov, demo video + post 20-21 Nov.**
- Solo entry (team submissions not allowed). Target: Overall winner + "Best Thoughtful Real-World Use".

Full product spec: `docs/SPEC.md`. Read it before writing code.

## Hard rules (from the challenge; breaking these disqualifies the entry)
- Must integrate SmartSpectra and use at least one **live** Presage signal. Judges verify via repo + demo video, so the integration must be obvious in code (one clearly named module) and on screen.
- **No medical claims.** Never use words like stress, anxiety, burnout, health, diagnosis, wellness score, or anything implying medical decisions. Vocabulary allowed: focus, flow, rhythm, presence, available, away, talking.
- **No covert or non-consensual monitoring.** Camera is off until the user explicitly turns it on. A visible indicator whenever it is on. Never monitor anyone other than the consenting user at the keyboard. No "manager view", no team dashboards of other people's state.
- Must ship: public repo, setup instructions, demo video, DEV post with a full **Consent and Data Handling** section (storage, sharing, retention, deletion, SDK telemetry, any AI service use).
- Must include testing instructions for judges without our credentials: ship a **"Sample recording (not live)" replay mode** that feeds recorded metrics (never video) through the same pipeline, clearly labelled.

## Privacy and data rules (design constraints, not nice-to-haves)
- Video frames are processed locally by the SDK. Never save or upload frames.
- **Raw vitals (pulse, HRV, breathing values) never leave the signal module.** Downstream code (integrations, MCP, timeline) only ever sees the derived state enum + timestamps.
- Pulse MCP exposes only: `state`, `since`, `focusMinutesToday`, and the queue of held agent messages. Never vitals.
- Timeline stores only state transitions and dev events, in a local SQLite DB in the app data dir. One-click "Delete all data". Configurable retention (default 30 days).
- SDK telemetry (`enableTelemetry`) is **off by default**, with an opt-in toggle on the consent screen. Read https://smartspectra.presagetech.com/docs/telemetry-and-privacy and reflect it accurately.
- Do not use `sdk.requestInsight()` (LLM Insights). If ever added, it must be opt-in and disclosed.
- The SDK contacts Presage to validate the API key. Disclose this.
- API keys and OAuth tokens are stored with the OS keychain (`safeStorage` in Electron or `keytar`), never plain text, never committed. `.env` is gitignored; ship `.env.example`.

## Tech stack (decided)
- **Electron >= 28, Node >= 20 (24 LTS recommended), TypeScript**, Vite for the renderer, React for UI (keep it lean).
- SDK: `@smartspectra/node-sdk` using the Electron entry points:
  - main: `bindSmartSpectraIpc(win)` from `@smartspectra/node-sdk/main`
  - preload: `@smartspectra/node-sdk/preload`
  - renderer: `SmartSpectraSDK` from `@smartspectra/node-sdk/renderer`
  - decode: `decodeMetrics` from `@smartspectra/node-sdk/messages`
- Local DB: `better-sqlite3` (or `node:sqlite` if stable on our Node version).
- MCP: `@modelcontextprotocol/sdk`, stdio transport, plus a localhost-only HTTP/SSE option. Bind to 127.0.0.1 only.
- Packaging: electron-builder with **per-OS `extraResources` blocks** for the SmartSpectra native package (see SDK docs; do not use the `${platform}` macro). GitHub Actions matrix builds for win-x64, linux-x64, mac-arm64 on tag.
- Tests: vitest. The signal processor and state machine must be unit tested using the replay recordings.

## SDK facts and gotchas (verified from docs, 6 Nov 2026)
- Docs: https://smartspectra.presagetech.com/docs/nodejs | API ref: https://smartspectra.presagetech.com/docs/nodejs/api-reference | Metrics: https://smartspectra.presagetech.com/docs/nodejs/metrics | Sample app: electron-quickstart in https://github.com/Presage-Security/SmartSpectra
- API key: https://physiology.presagetech.com/auth/register
- **Supported platforms: darwin-arm64, linux-x64, linux-arm64, win32-x64. No Intel Mac.** State this in README.
- Linux needs glibc >= 2.35 (Ubuntu 22.04+, Debian 12+).
- `npm install` pulls native runtimes for all platforms (a few hundred MB). Expected.
- CSP must allow `worker-src 'self' blob:` or the renderer worker fails at `start()`.
- Camera permission: use `setPermissionRequestHandler` that grants only `media` and only to our `file://` page. macOS needs `NSCameraUsageDescription`; for signing, `com.apple.security.cs.disable-library-validation` entitlement.
- SDK locks AE/AWB/focus while running. Another entrant found some Linux drivers keep the lock after stop, making the next session dark. Reset camera to auto exposure after stop on Linux.
- Use monotonic timestamps (`process.hrtime.bigint() / 1000n`), not wall clock, if sending custom frames.
- Events to wire: `metrics`, `validationStatus` (code, ts, hint), `processingStatus`, `error` (code, message, retryable), `streamAvailable`.
- Signals we use: `breathing.upperTrace`, `breathing.rate`, `face.talking`, face presence / validation status, `face.expression` (optional). Confirm exact field names in the metrics guide before coding; do not guess.
- **Credits:** challenge runs on Presage's free trial with no extra credits. FlowState must NOT run the SDK continuously all day. Use duty-cycled sampling (default: 60 s sample every 5 min, plus continuous only while a focus session is being confirmed). Make the cadence configurable and log SDK minutes used per day in the UI. If we hit limits, ask on the Presage Discord.

## Architecture (module boundaries; keep them strict)
```
src/
  main/                 Electron main: windows, tray, IPC, SDK IPC binding, scheduler
  preload/              contextBridge (SDK preload + our typed API)
  renderer/             React UI: onboarding/consent, tray popover, settings, timeline
  signals/              ONLY place that touches SmartSpectra metrics
    sdk-session.ts      start/stop/duty-cycle, validation hints, errors
    processor.ts        raw metrics -> features (breath steadiness, talking, presence)
    replay.ts           JSONL metrics recorder + replay source (same interface as live)
  state/
    machine.ts          features -> DevState (focused/available/talking/away) with hysteresis
  integrations/         each implements Integration { onEnterFocus, onExitFocus, test() }
    os-focus/           macOS Focus (Shortcuts CLI), Windows Focus Assist, GNOME/KDE DND
    slack/ teams/ discord/ gcal/
  mcp/                  Pulse MCP server (reads DevState only)
  timeline/             SQLite store, git watcher, test/CI ingest, queries
  shared/               types, event bus, config, keychain helpers
docs/
recordings/             sample metrics sessions (JSONL), used by tests + judge demo mode
```
Data flows one way: `signals -> state -> (integrations | mcp | timeline)`. Nothing downstream imports from `signals/`.

## Working agreements
- Run `npm run lint && npm test` before every commit. Small commits, conventional messages.
- Build the vertical slice first (see SPEC milestones), then widen. A working demo on 19 Nov beats a half-built feature list.
- When unsure about an SDK API, read the API reference or the electron-quickstart source instead of guessing.
- Keep a running `docs/DEVLOG.md` (date, what changed, decisions). It feeds the DEV post and the optional agent-session transcript.
- Writing style for README, UI copy and DEV post: plain, direct, numbers first, **no em dashes**, should not read as AI-generated.
- Ask the user (Subham) before: adding a paid service, adding any cloud upload, changing the privacy rules above, or anything that touches a real Slack/Teams workspace outside a test workspace.
