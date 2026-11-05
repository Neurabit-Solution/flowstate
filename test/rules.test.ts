import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isCameraRequestAllowed } from '../src/main/permissions';

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

  it('turns telemetry off explicitly, since the SDK defaults it on', () => {
    expect(readFileSync('src/signals/debug-panel.tsx', 'utf8')).toMatch(/enableTelemetry: false/);
  });

  it('starts the camera only from a click handler', () => {
    const panel = readFileSync('src/signals/debug-panel.tsx', 'utf8');
    expect(panel.match(/startLive\(/g)?.length).toBe(1);
    expect(panel).toMatch(/onClick=\{\(\) => void startLive\(\)\}/);
  });
});
