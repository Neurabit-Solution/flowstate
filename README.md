# FlowState

Notices when you are in flow and protects it. Camera on only when you say so. Built on the Presage SmartSpectra SDK.

Status: M0 scaffold. See `docs/SPEC.md` for the plan and `docs/DEVLOG.md` for progress.

## Run

Needs Node 20 or newer (24 LTS recommended). `npm install` downloads native runtimes for every platform, a few hundred MB.

```bash
npm install
cp .env.example .env   # then set PRESAGE_API_KEY
npm start
```

No key? Skip the `.env` step and click **Use sample recording**. It works without a key or a camera.

Scripts: `npm run dev` (rebuild on change, Ctrl+R to reload the window), `npm run lint`, `npm test`.

## Platforms

macOS Apple Silicon, Linux x64 and arm64 (glibc 2.35+, so Ubuntu 22.04+ or Debian 12+), Windows x64. Intel Macs are not supported by the SDK. Not a medical device.
