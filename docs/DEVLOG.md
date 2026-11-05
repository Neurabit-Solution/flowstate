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
- `recordings/synthetic-smoke.jsonl` is generated test data. The real recordings the spec asks for need a person at the camera.
- `.env` holds the key for M0. Keychain storage arrives with onboarding in M1.
