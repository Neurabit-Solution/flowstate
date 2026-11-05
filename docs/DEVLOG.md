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
- With no face, one run ended in SDK error 8 (`kProcessingFailed`, retryable) after about 10 s. The cause is not confirmed. If a real empty chair does the same, M1 must treat it as `away` and restart the session, not as a failure. Check this first in M1.
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
- Live with no face: samples ran on schedule, each ended early by SDK error 8, and the state reached away at about 60 s. So an empty frame looks like this error, and the duty cycle treats it as retry next cycle.
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
