import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { apiKeyProblem } from '../src/main/api-key';
import { isCameraRequestAllowed } from '../src/main/permissions';
import { DEFAULT_SETTINGS } from '../src/shared/types';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const PAGE = 'file:///app/dist/renderer/index.html';

describe('camera permission', () => {
  const ask = (over: Partial<Parameters<typeof isCameraRequestAllowed>[0]>) =>
    isCameraRequestAllowed({ permission: 'media', mediaTypes: ['video'], requestingUrl: PAGE, ...over }, PAGE);

  it('allows only a video request from our page', () => {
    expect(ask({})).toBe(true);
    expect(ask({ mediaTypes: ['video', 'audio'] })).toBe(false);
    expect(ask({ mediaTypes: ['audio'] })).toBe(false);
    expect(ask({ mediaTypes: [] })).toBe(false);
    expect(ask({ permission: 'geolocation' })).toBe(false);
    expect(ask({ requestingUrl: 'https://example.com/' })).toBe(false);
    expect(ask({ requestingUrl: 'file:///tmp/other.html' })).toBe(false);
  });
});

describe('API key check', () => {
  it('rejects what is clearly not a key', () => {
    expect(apiKeyProblem('')).toMatch(/empty/);
    expect(apiKeyProblem('api key')).toMatch(/spaces/);
    expect(apiKeyProblem('short')).toMatch(/too short/);
    expect(apiKeyProblem('  abcdefghijklmnopqrstuvwxyz0123456789ABCD\n')).toBeNull();
  });
});

describe('repo rules from CLAUDE.md', () => {
  it('nothing downstream imports from signals or the SDK', () => {
    const downstream = ['src/state', 'src/integrations', 'src/mcp', 'src/timeline', 'src/shared'].flatMap(walk);
    for (const file of downstream) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/from\s+['"][^'"]*(signals|@smartspectra)/);
    }
  });

  it('only the signal module and the main binding reference the SDK', () => {
    const offenders = walk('src')
      .filter((f) => !f.startsWith(join('src', 'signals')))
      .filter((f) => /@smartspectra/.test(readFileSync(f, 'utf8')))
      .sort();
    expect(offenders).toEqual([join('src', 'main', 'index.ts'), join('src', 'preload', 'index.ts')].sort());
  });

  it('never calls the LLM insights API', () => {
    for (const file of walk('src')) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/requestInsight/);
    }
  });

  it('uses no banned words in shipped source', () => {
    const banned = /\b(stress|anxiety|burnout|diagnos\w*|wellness|health)\b/i;
    for (const file of walk('src')) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(banned);
    }
  });

  it('turns telemetry off by default and always passes it to the SDK, which defaults it on', () => {
    expect(DEFAULT_SETTINGS.telemetry).toBe(false);
    expect(readFileSync('src/signals/sdk-session.ts', 'utf8')).toMatch(/enableTelemetry: this\.options\.enableTelemetry\(\)/);
  });

  it('starts the camera only from a click or the tray command', () => {
    const callers = walk('src')
      .filter((f) => /host\.startSensing\(|this\.startSensing\(/.test(readFileSync(f, 'utf8')))
      .sort();
    expect(callers).toEqual([join('src', 'renderer', 'App.tsx'), join('src', 'renderer', 'Onboarding.tsx'), join('src', 'signals', 'host.ts')].sort());
    for (const file of ['src/renderer/App.tsx', 'src/renderer/Onboarding.tsx']) {
      for (const line of readFileSync(file, 'utf8').split('\n').filter((l) => l.includes('host.startSensing('))) {
        // Inside an onClick: same line, or the body of a multi-line handler.
        expect(readFileSync(file, 'utf8')).toMatch(/onClick=\{\(\) => (void host\.startSensing|\{\s+setStep\('calibrate'\);\s+void host\.startSensing)/);
        expect(line.includes('useEffect')).toBe(false);
      }
    }
    expect(readFileSync('src/signals/host.ts', 'utf8')).toMatch(/command\.type === 'start-sensing'\) void this\.startSensing\(\)/);
    expect(readFileSync('src/main/index.ts', 'utf8').match(/type: 'start-sensing'/g)?.length).toBe(4);
  });

  it('opens a camera only inside the live session', () => {
    const offenders = walk('src').filter((f) => /getUserMedia\(/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([join('src', 'signals', 'sdk-session.ts')]);
  });

  it('keeps yes/no features free of raw values', () => {
    const types = readFileSync('src/shared/types.ts', 'utf8');
    expect(types).not.toMatch(/upperTrace|breathing|pulseRate|\brate:|hrv/i);
    expect(readFileSync('src/state/machine.ts', 'utf8')).not.toMatch(/upperTrace|breathing|pulse/i);
  });
});
