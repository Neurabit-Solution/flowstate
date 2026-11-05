# FlowState dev log

## 2026-11-06: M0 scaffold

**Changed**
- Electron, TypeScript, Vite and React scaffold with the folder layout from CLAUDE.md.
- SmartSpectra SDK 3.4.0 wired through the main, preload and renderer entry points.
- Debug screen: breathing trace, talking flag, validation hints, camera-on badge.
- JSONL metrics recorder and a replay source behind the same `SignalSource` interface as live.
- vitest suite: replay, recorder, protobuf field names, camera permission, repo rules.

**Confirmed against SDK docs and source**
- Field names: `breathing.upperTrace[]` and `breathing.rate[]` hold `{ value, stable, timestamp }` (rate adds `confidence`). `face.talking[]` holds `{ detected, stable, timestamp }`. Timestamps decode as protobuf Long.
- `metrics` events are windowed slices since the previous event, so consumers accumulate them.
- Event signatures match CLAUDE.md: `metrics(buf, ts)`, `validationStatus(code, ts, hint)`, `processingStatus(status)`, `error(code, message, retryable)`, `streamAvailable(stream)`.

**Differences from CLAUDE.md**
- `enableTelemetry` defaults to true in the SDK. We pass false explicitly.
- `face.talking` is empty unless requested. The default bundle is breathing only.
- There is no face presence field. Presence has to come from `validationStatus`, which M1 must treat as a state rather than a per-frame sample.
- The renderer SDK takes `apiKey` in its constructor, so the key reaches the renderer at start. It is fetched over IPC only on the click and only by our page. Keychain storage in M1 protects the key at rest but cannot change this.
- The sample's permission handler also requires video-only. We adopted that, plus an exact page URL match instead of any `file://`.
- Measurement authenticates online with no offline mode, and metering (`kCreditExhausted`) implies more than a one-time key check. The consent copy and DEV post should not imply that key validation is the only network use without confirming with Presage.
- Packaged builds must set `SMARTSPECTRA_CAPI_PATH` before requiring the SDK. Already handled in `src/main/index.ts`; M5 needs the `extraResources` blocks.

**Decisions**
- Request `CHEST_BREATHING`, `BREATHING_RATE` and `TALKING` by hand, not the `breathingMetrics` bundle (which also includes apnea and other values we have no use for) and no cardio metrics. Less data, and it keeps medical-sounding outputs out of the app.
- The renderer always loads from `file://`, in dev too, so the camera rule has no dev exception. Cost: no hot reload.
- Main and preload are built with esbuild. The preload must be bundled because a sandboxed preload cannot require from node_modules.
- Recording is off by default and needs a tick. It writes plain JSON with raw trace values, so `recordings/live-*.jsonl` is gitignored until someone deliberately adds a file.
- The debug panel lives in `src/signals/` because it is the only UI allowed to see raw values.
- A 15 minute cap on live sessions protects trial credits until M1 adds duty cycling.

**Verified with a fake camera feed (Chromium's `fake_device_0`, real API key)**
- The key authenticated and the SDK reached Running. Validation reported no face, as expected, and no metrics arrived.
- With no face, one run ended in SDK error 8 (`kProcessingFailed`, retryable) after about 10 s. (Later traced to frame rate, see the entry below.)
- The camera now stops on the SDK error state instead of staying open.
- A click on anything except the button leaves the camera off (30 s control run).

**Not verified yet**
- Real breathing trace and talking values, which need a real face in front of a real camera.
- Linux auto exposure reset after stop, which needs real hardware.

**Not done yet**
- The `recordings/synthetic-*.jsonl` files are generated test data. The real recordings the spec asks for need a person at the camera.
- `.env` holds the key for M0. Keychain storage arrives with onboarding in M1.

## 2026-11-06: M1 core loop

**Changed**
- `signals/processor.ts`: metrics to yes/no features (present, talking, steady).
- `state/machine.ts`: features to DevState with hysteresis, manual overrides and an immediate away on screen lock.
- `signals/duty-cycle.ts`: 60 s every 5 min, staying on up to 5 min to confirm a change around focus. Counts SDK minutes per day.
- `signals/host.ts`: runs the pipeline in the renderer, and only features cross to main.
- Tray with state, camera-on ring, overrides, pause, stop and SDK minutes.
- Consent onboarding, keychain storage for the key, settings, Delete all data.
- `--demo` flag: focus after 30 s for the video. Use `npm start -- --demo`.

**Verified by driving the app with a fake camera feed and an isolated profile**
- Sample replay (talking interruption): warming up, available, focus, in a conversation, available, off. The camera stayed off throughout.
- Live with no face: samples ran on schedule, each ended early by SDK error 8, and the state reached away at about 60 s. (Wrong conclusion, see the frame rate entry below: the error came from the frame rate, not the empty frame.)
- Key saved to the keychain was not readable as plain text. Delete all data removed settings.

**Findings**
- SDK logs show it fetches encrypted model files from the network (`secure_model_loader`). So "validates the API key" was not the whole network story, and the consent screen now says so. The DEV post must say the same. Confirm the full list with Presage.
- The expression model is fetched even though we do not request expressions.

**Decisions**
- Features crossing to main are yes/no. The steadiness score stays in `signals/`, which is stricter than the spec's 0..1 feature, and it keeps the "no raw values downstream" rule easy to check.
- Only "no face" counts as absent. Bad lighting or a poor angle still means someone is there.
- "Pause until tomorrow" is a plain stop with no timer, so the camera can never restart overnight on its own. Pauses of 15 min and 1 h do resume.
- Sensing never restarts at launch. The choice is not remembered.
- The baseline lives in memory for now, so it restarts with each launch.
- Key saving refuses when Linux has no real keyring, rather than falling back to plain text.

**Not verified yet**
- Everything about real breathing data. Steadiness thresholds were only tested on generated recordings, so the 10 minute focus result says the logic works, not that it detects real focus.
- The tray menu itself (the same code paths were driven from the window). Some GNOME setups hide tray icons, so closing the window while sensing shows a notification.
- Screen lock handling, which needs a real lock.

## 2026-11-06: Linux sandbox failure on first real launch

Subham's `npm start` aborted with a Chromium SUID sandbox error on Ubuntu 26.04. Ubuntu sets `kernel.apparmor_restrict_unprivileged_userns=1`, so Electron falls back to `chrome-sandbox`, which must be root-owned with mode 4755. My earlier test runs passed only because they inherited a less restricted AppArmor profile from the Claude desktop app, so they did not match a normal terminal. Reproduced with `systemd-run --user`.

**Decisions**
- Do not pass `--no-sandbox`. It would turn off the renderer sandbox in a camera app. `scripts/launch.mjs` now prints the exact fix instead.
- Test launches on Linux must run through `systemd-run --user`, or they miss this class of failure.

**For M5:** judges on recent Ubuntu hit this too. An AppImage cannot set the SUID bit, so ship a `.deb` (its install script sets it) and test both from a normal session. Check that this is true of the electron-builder version we use.

Second failure once the helper was set: `LaunchProcess: failed to execvp` cut off at the space in the project path, because Chromium's SUID path cannot handle spaces. On this machine Electron now lives in `~/.cache/flowstate-electron/dist`, linked back from `node_modules/electron/dist`. Tested from a normal session with `systemd-run --user`: the app stayed up until the test killed it. `scripts/launch.mjs` and the README now explain this.

Third failure: `401 Invalid or missing API key`. The value saved during onboarding decrypted to 15 characters at most, judging by the 19 byte file, and it takes priority over `.env`. The `.env` key shows no 401s on a fake feed. Removed the saved value. The app now rejects implausible keys on save, says when Presage rejects the key, and has a replace field in Settings.

Correction: reaching SDK status Running does not prove the key works, because the SDK reports Running and takes frames after a 401. Check for 401s in the SDK log instead.

## 2026-11-06: SDK error 8 is frame rate, not an empty frame

Subham's real camera session stopped after about 10 s, delivering about 10 fps. The native library contains the text "Frame rate stayed below the ... fps minimum for too long to measure reliably", and the docs ask for roughly 25 fps. The JS error only says "processing failed".

Chromium's fake camera runs at 20 fps by default, which explains the earlier fake feed failures. With `--use-fake-device-for-media-stream=fps=30` the app ran 40 s at about 30 fps with no error and no face. So the pipeline holds 30 fps, and my earlier "an empty frame causes error 8" was wrong.

Subham's webcam lists MJPG 1280x720 at 30 fps, so the likely cause is auto exposure slowing it down in low light. Not confirmed yet. The app now measures delivered frames per second, shows it in the live signal panel, and explains a slow camera.

Use `fps=30` for all fake feed tests from now on.

## 2026-11-06: Camera picker

Subham asked to switch cameras when several are present. Home and onboarding show a picker only with 2 or more cameras. Listing them does not turn one on. Choosing a camera opens it ourselves with the same constraints as the SDK default and hands it over through `useMediaStream`, so we stop those tracks ourselves. Switching while on restarts the session. If the chosen camera is gone, the app says so and uses the default.

## 2026-11-06: First real session

A 56 s live run with the camera moved and the chest in frame finished its full sample with no SDK error. Results: trace at 25 samples a second, talking readings throughout, breathing rate confidence reaching 69, and about 25 fps, right at the SDK's floor (`kFrameRateTooLow` in most checks).

**Problem found:** the trace is marked `stable` only from about 32 s, which matches the docs' 30 s window. The processor scores stable samples only, so a 60 s sample leaves about 23 s, too few breaths to score. `steady` stayed null, so automatic focus could never start on the default cadence. The generated recordings hid this because every sample in them is stable.

**Next:** get a longer real recording, then choose between a longer default sample and a looser scoring rule. Generated recordings should also start with a 30 s unstable stretch, so tests catch this.

## 2026-11-06: M2 integrations

**Changed**
- `integrations/manager.ts` calls each enabled integration on focus start and end. One failing never stops the rest, and everything is logged.
- OS focus: GNOME through gsettings, macOS through two user-made shortcuts. Windows and other Linux desktops report that they are manual.
- Slack: Do Not Disturb and status, with the previous status restored. Google Calendar: one busy block, extended during focus and ended at exit.
- Anything changed is saved first and undone at quit or, after a crash, at next launch.

**Decisions**
- All integrations are off until turned on. Sample recordings log what they would do and never change anything.
- Slack uses a pasted user token from the user's own Slack app rather than OAuth, because Slack requires an HTTPS redirect and that would need a hosted service. This differs from the spec.
- Google needs the user's own OAuth desktop client for now. Shipping a shared one needs a Google project and its verification, which is Subham's call.
- KDE is reported as manual, not built: I have no way to test it here, and the spec lists it as cuttable. Windows has no supported API, which the spec allows for.

**Not verified yet**
- All of it against real services. Tests use fakes, and nothing has run against a real Slack, Google account or real notification setting. macOS and Windows have not run at all.

## 2026-11-06: M3 Pulse MCP

**Changed**
- `mcp/core.ts` holds the tool logic. It sees only DevState, so it cannot expose raw signals.
- The app runs Streamable HTTP on 127.0.0.1 with a per-install bearer token, plus Host and Origin checks against requests from web pages.
- `dist/mcp/stdio.js` is what agents launch. It forwards to the app through `pulse.json` (mode 600).

**Decisions**
- With the app closed, the bridge answers "off" and allows interruptions. A closed app must not block an agent.
- `talking` is treated like `focused` for interruptions. The spec only covered focused and away.
- `off` and `warming_up` allow interruptions, since nothing is being protected yet.
- The setup command runs Electron as Node, so users do not need Node installed and the same command works when packaged.
- The setup gives a command to copy and does not edit anyone's agent config.
- Held messages and focus blocks live in memory until M4 adds the store, so a restart loses them.

**Not verified yet**
- A real Claude Code, Cursor or Copilot CLI session. Tests use the official MCP client over HTTP and stdio. The Copilot CLI config format is from memory and needs checking.
