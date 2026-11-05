# FlowState spec (v0.1, challenge build)

## 1. One-liner
A desktop app that notices when you are in flow, protects it across Slack, Teams, Discord, your OS and your calendar, tells your coding agents to wait, and shows you a private timeline of when you focus best. Camera on only when you say so. Vitals never leave your machine, and never leave the signal module.

## 2. Users and jobs
- Developer working solo or remote: "Stop pinging me when I'm deep in it, and don't make me remember to toggle 4 DND switches."
- Developer using AI agents: "Batch your questions while I'm heads down; give me a summary when I look up."
- Developer curious about their own patterns: "When do I actually focus, and what keeps breaking it?"

## 3. Dev state model
`DevState = 'off' | 'warming_up' | 'away' | 'talking' | 'available' | 'focused'`

Features from `signals/processor.ts` (rolling windows):
- `present`: face/chest valid per `validationStatus` for >= 80% of the last 20 s.
- `talking`: `face.talking` true for >= 30% of the last 20 s.
- `breathSteadiness`: 0..1, from regularity of breath intervals and depth on `breathing.upperTrace` over the last 2 min, normalized to the user's own rolling median (never an absolute "good" value).
- `stillness`: optional, from validation hints / movement if available.

Transitions (with hysteresis so it doesn't flap):
- `away`: not present for >= 60 s.
- `talking`: present and talking.
- `focused`: present, not talking, steadiness above the user's personal baseline, sustained for `focusEnterMinutes` (default 10). Leaving focus needs 2 min of contrary signal, or the user being away/talking for 60 s.
- `available`: present, otherwise.
- Manual override from the tray always wins: "I'm focusing" / "I'm free" / "Pause sensing for 1 h".

Copy rule: the UI says "Focus", "Available", "In a conversation", "Away". It never shows a heart rate or breathing number on the main screen. A small "Live signal" debug panel (opt-in, shown in the demo video for judges) may show the live breathing trace so the SDK integration is visible.

## 4. Sampling and credits
- Default duty cycle: SDK runs for 60 s every 5 min. When the state machine is about to enter or leave `focused`, it keeps sampling continuously until confirmed (max 5 min), then returns to the cycle.
- Between samples, carry the state forward and use cheap OS signals as a hint: keyboard/mouse idle time (`powerMonitor.getSystemIdleTime()`), screen locked.
- Settings: cadence, focus threshold minutes, "always on while plugged in".
- The tray shows "SDK minutes today". Warn at a configurable daily cap.

## 5. Feature A: focus protection (tray app)
On `enterFocus` / `exitFocus`, call every enabled integration. Each integration needs: connect flow, `test()` button in settings, idempotent enter/exit, and a restore-previous-status behavior.

| Integration | Enter focus | Exit focus | Auth |
|---|---|---|---|
| OS: macOS | Turn on a Focus mode via Shortcuts CLI (`shortcuts run "FlowState On"`); ship instructions to create the two shortcuts | `shortcuts run "FlowState Off"` | none |
| OS: Windows | Focus Assist / Do Not Disturb (research the supported API for Win 11; fall back to a documented manual mode if no API) | restore | none |
| OS: Linux | GNOME: `gsettings set org.gnome.desktop.notifications show-banners false`; KDE: DBus `org.freedesktop.Notifications` inhibit | restore | none |
| Slack | `dnd.setSnooze` + status emoji/text "Focusing (FlowState)" | `dnd.endSnooze`, restore previous status | OAuth user token |
| Microsoft Teams | Graph `presence/setUserPreferredPresence` = DoNotDisturb | clear preferred presence | MS OAuth (device code flow) |
| Discord | Rich presence / status via local RPC if feasible; otherwise skip for v0.1 | | |
| Google Calendar | Create a "Focus time (FlowState)" event from now for the expected block, mark busy; extend while focus continues | end the event at exit time | Google OAuth (loopback) |

Priority for the challenge: OS (all 3) + Slack + Google Calendar are **must**. Teams is **should**. Discord is **could**.

Never post anything to channels. Only the user's own status, DND and calendar.

## 6. Feature B: Pulse MCP
Local MCP server started by the app (stdio for agents launched by the user, plus `127.0.0.1` HTTP/SSE). Provide a one-click "Add to Claude Code" that writes or prints the correct `claude mcp add` command, and config snippets for Cursor and Copilot CLI.

Tools:
- `get_dev_state()` -> `{ state, since, focusMinutesToday, heldMessages: n }`
- `should_interrupt(priority: 'low'|'normal'|'urgent', reason: string)` -> `{ allow: boolean, retryAfterSeconds?, advice }`. Focused: only `urgent` allowed. Away: none, queue it.
- `queue_message(text, priority, source)`: hold a message for the user. Shown in the tray and delivered as a desktop notification when state becomes `available`.
- `wait_until_available(timeoutSeconds)`: long-poll until available or timeout.
- `get_focus_summary(range)`: aggregate focus minutes and blocks (no vitals).

Resources: `devstate://current` (subscribable, notify on change).

Ship a short `AGENTS-SNIPPET.md` users can paste into their CLAUDE.md / agent rules: "Before asking the user a non-blocking question, call should_interrupt. If not allowed, queue_message and continue working."

Security: localhost only, random port, per-install bearer token for HTTP. The MCP server never exposes vitals or raw signals, by construction (it only imports `state/`).

## 7. Feature C: Dev Day Replay (timeline)
Local SQLite tables:
- `state_spans(id, state, start_ts, end_ts, source: live|manual|replay)`
- `dev_events(id, ts, kind, repo, detail_json)` where `kind` is commit | branch_switch | test_run | build | ci_run | agent_message.
- `settings`, `integration_log(ts, integration, action, ok, error)`.

Ingest:
- Git: user picks repo folders; watch `.git/logs/HEAD` (or poll `git log`) for commits and branch switches. Store hash, message first line, files changed count.
- Tests/builds: a tiny CLI `flowstate run -- npm test` that records start, end, exit code and duration. Plus a VS Code task snippet.
- CI: optional GitHub Actions ingest via `gh api` polling of the user's repos (no inbound webhooks, no server).
- Agent messages from Pulse MCP.

Views:
- Day view: horizontal band of state spans with event markers on top.
- Week view: heatmap of focus minutes by hour x weekday.
- Insights (plain rule-based, no LLM): "Longest focus blocks: 10:00-12:00", "Focus blocks that ended within 2 min of a build longer than 5 min: 6", "Median focus block: 38 min". No judgments of "good" or "bad", just patterns.
- Export: CSV of state spans and events. Delete: per day, or everything. Retention setting, default 30 days.

## 8. Onboarding and consent (judged heavily: build this well)
1. Welcome: what FlowState does in 3 lines, and "Not a medical device".
2. Data screen (plain language, matches the DEV post section): what is processed, where, what is stored, what is never stored, network calls (Presage key check only), telemetry toggle (off by default), retention, how to delete.
3. API key entry (stored in keychain) or "Try with sample recording".
4. Camera: "Turn on camera" button. Never auto-start on first launch. Tray icon shows a distinct camera-on state.
5. Calibration: 2 min quiet working baseline. Show the SDK's own validation hints until the picture is good.
6. Connect integrations (each optional, each with a test button).
7. Connect agents (Pulse MCP snippets).

Global controls always one click away in the tray: Pause sensing (15 min / 1 h / until tomorrow), Stop camera, Open timeline, Quit.

## 9. Judge / demo mode
- `recordings/*.jsonl`: at least 3 real recorded sessions (focused block, talking interruption, away), metrics only.
- "Use sample recording" plays them through `signals/replay.ts`, labelled "Sample recording (not live)" everywhere in the UI.
- A `--demo` flag that speeds up time (focus threshold 30 s) for the video.

## 10. Milestones (today is 6 Nov; deadline 22 Nov PST)
- **M0 (6-7 Nov) scaffold:** Electron + TS + Vite + React, SDK wired via electron-quickstart pattern, live breathing trace on a debug screen, recorder writing JSONL. Commit recordings.
- **M1 (8-10 Nov) core loop:** processor + state machine + unit tests from recordings; tray with state + manual overrides; duty-cycled sampling; consent onboarding.
- **M2 (11-13 Nov) integrations:** OS focus on all 3 OSes, Slack, Google Calendar. Integration log.
- **M3 (14-15 Nov) Pulse MCP:** tools, resource, Claude Code one-click setup, AGENTS-SNIPPET.md. Test with a real Claude Code session.
- **M4 (16-17 Nov) timeline:** SQLite, git watcher, `flowstate run`, day + week views, insights, export/delete.
- **M5 (18-19 Nov) polish + packaging:** Teams if time, GitHub Actions builds (win-x64, linux-x64, mac-arm64), README with setup + judge instructions, code freeze 19 Nov.
- **M6 (20-21 Nov) submission:** 2-3 min demo video (show consent screen, live signal panel, focus kicking in, Slack/calendar/OS changing, Claude Code calling should_interrupt and queueing, timeline). DEV post from the official template including Consent and Data Handling and Prize Categories (Best Thoughtful Real-World Use). Optional: curated agent-session transcript, scrubbed of keys.

If behind schedule, cut in this order: Discord, Teams, CI ingest, week heatmap, Linux KDE. Never cut: consent flow, replay mode, OS + Slack, Pulse MCP, day timeline.

## 11. Acceptance checklist for submission
- [ ] Fresh clone -> `npm install` -> `.env` with key -> `npm start` works on Windows, Linux, macOS arm64.
- [ ] Without a key, sample recording mode runs every feature end to end.
- [ ] Camera never starts without a click; indicator visible whenever on.
- [ ] grep the repo: no vitals values outside `src/signals/`; MCP and timeline have no imports from `signals/`.
- [ ] No banned words in UI copy, README or post (stress, anxiety, burnout, health score, diagnose, wellness).
- [ ] Delete all data works and is verified by test.
- [ ] Telemetry off by default; toggle works.
- [ ] Installers attached to a GitHub release.
- [ ] Demo video clearly shows a live Presage signal and the SDK code module.
