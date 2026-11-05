# Consent and data handling

Source text for the DEV post. Keep it in step with the onboarding data screen.

## Consent

- The camera is off until you click **Turn on camera**. FlowState never starts it at launch and does not remember the choice between launches.
- While it is on, the app shows a "Camera on" badge and the tray icon gets a red ring. Between samples the camera really is off.
- It is for the person at the keyboard, who turned it on. There is no manager view and no team view.
- By default the SDK runs 60 seconds every 5 minutes. **Stop camera** and **Pause** are one click away in the tray and the app.

## What is processed and where

Video frames go from your camera to the SDK on your computer. FlowState never saves or uploads them.

FlowState requests three metrics: chest breathing, breathing rate and talking. It does not request pulse, HRV or any cardio metric. Those values stay inside the signal module (`src/signals/`). Everything else sees only yes or no answers and the resulting state.

## What is stored

Everything is stored under your app data folder.

| What | Where | How long |
|---|---|---|
| State changes, and commits, branch switches and test runs if you turn them on | `timeline.db` (SQLite) | 30 days by default, configurable |
| Who sent a held agent message, priority and length, but not its text | `timeline.db` | Same |
| Settings and SDK minutes for the day | `settings.json` | Until deleted |
| Integration log and what to restore after focus | `integration-state.json` | Until deleted, last 200 entries |
| API key and account tokens | Encrypted by your OS keychain | Until deleted |
| Breathing values and talking flags, only if you tick "Save metrics" | `recordings/live-*.jsonl`, plain text | Until deleted |

Video and images are never stored. Held agent messages stay in memory until delivered.

If your Linux has no keyring, FlowState refuses to save the key or tokens rather than store them as plain text.

## What is shared

Nothing goes to us. There is no FlowState server and no analytics.

- **Presage:** the SDK connects to Presage to validate your API key, and fetches the models it runs on your computer. Check Presage's [privacy policy](https://api.physiology.presagetech.com/privacypolicy).
- **Slack and Google Calendar:** only if you connect them, and only your own status, Do Not Disturb and calendar. FlowState never posts to channels.
- **Your coding agents:** a server on 127.0.0.1 gives them your state, since when, focus minutes and held messages, with a per-install token. Never raw signals.

## SDK telemetry

Off by default. The SDK itself defaults it to on, so FlowState always passes the setting explicitly. You can opt in on the data screen or in Settings.

If you opt in, the SDK sends one summary per session: SDK version, platform, OS version, device model, CPU architecture, frame and timing counts, how many metrics were requested, counts of camera warnings and a coarse error code. Per Presage's [telemetry docs](https://smartspectra.presagetech.com/docs/telemetry-and-privacy), it never includes video, measured values, or user or device identifiers.

## AI services

FlowState uses none. It does not call the SDK's LLM Insights. Patterns on the timeline come from plain rules.

## Deleting

**Settings > Delete all data** removes the API key, connected accounts, timeline, settings, logs and saved metric files. **Delete this day** removes one day. Uninstalling the app does not remove the app data folder, so use Delete all data first.

## Not a medical device

FlowState makes no medical claims. It reports focus, presence and availability, and shows you only your own patterns.
