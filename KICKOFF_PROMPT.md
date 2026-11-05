# Paste this into Claude Code as the first message

Read CLAUDE.md and docs/SPEC.md fully. This is FlowState, my entry for the Presage SmartSpectra SDK Challenge on DEV.to (deadline 22 Nov 2026 PST).

Before writing code:
1. Fetch and read the SmartSpectra Node/Electron docs, the API reference and the metrics guide (links in CLAUDE.md), and the electron-quickstart sample in github.com/Presage-Security/SmartSpectra. Confirm exact metric field names and event signatures, and note anything that contradicts CLAUDE.md.
2. Give me a short plan for milestone M0 only, plus any questions that block it (for example: my OS for first-run testing, whether I already have a Presage API key).

Then build M0:
- git init, Electron + TypeScript + Vite + React scaffold with the folder layout from CLAUDE.md
- SmartSpectra wired via the Electron entry points (main/preload/renderer), CSP allowing worker-src blob:, camera permission handler limited to our page
- Consent-first: camera only starts on a button click
- Debug screen showing the live breathing trace, talking flag and validation hints
- Metrics recorder to recordings/*.jsonl (metrics only, never frames) and a replay source behind the same interface
- .env.example, .gitignore, npm scripts for dev/lint/test, vitest set up with one test that replays a recording
- docs/DEVLOG.md started

Stop after M0 and show me how to run it. Commit as you go. Follow the privacy rules and banned-words rule in CLAUDE.md exactly.
