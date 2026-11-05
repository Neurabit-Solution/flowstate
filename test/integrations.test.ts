import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GcalIntegration } from '../src/integrations/gcal';
import type { GoogleTokens } from '../src/integrations/gcal/oauth';
import { IntegrationManager } from '../src/integrations/manager';
import { createOsFocus, GnomeFocus, MacFocus } from '../src/integrations/os-focus';
import { SlackIntegration } from '../src/integrations/slack';
import type { Fetch, Integration, StateStore } from '../src/integrations/types';

function memoryStore(): StateStore {
  const map = new Map<string, unknown>();
  return { get: <T,>(k: string) => map.get(k) as T | undefined, set: (k, v) => void map.set(k, v), delete: (k) => void map.delete(k) };
}

describe('manager', () => {
  function fake(id: string, overrides: Partial<Integration> = {}) {
    const calls: string[] = [];
    const integration: Integration = {
      id,
      label: id,
      ready: () => true,
      onEnterFocus: async () => void calls.push('enter'),
      onExitFocus: async () => void calls.push('exit'),
      onStillFocused: async () => void calls.push('extend'),
      test: async () => ({ ok: true, detail: '' }),
      ...overrides,
    };
    return { integration, calls };
  }
  const manager = (integrations: Integration[], store = memoryStore(), enabled = () => true) => new IntegrationManager({ integrations, store, isEnabled: enabled });

  it('acts only when focus starts or ends', async () => {
    const a = fake('a');
    const m = manager([a.integration]);
    await m.onState('available', false);
    await m.onState('focused', false);
    await m.onState('focused', false);
    await m.tick();
    await m.onState('talking', false);
    await m.onState('away', false);
    expect(a.calls).toEqual(['enter', 'extend', 'exit']);
  });

  it('one failure does not stop the others, and is logged', async () => {
    const bad = fake('bad', { onEnterFocus: async () => Promise.reject(new Error('nope')) });
    const good = fake('good');
    const m = manager([bad.integration, good.integration]);
    await m.onState('focused', false);
    expect(good.calls).toEqual(['enter']);
    expect(m.entries.find((e) => e.integration === 'bad')).toMatchObject({ ok: false, error: 'nope' });
  });

  it('samples log but change nothing', async () => {
    const a = fake('a');
    const m = manager([a.integration]);
    await m.onState('focused', true);
    await m.onState('available', true);
    expect(a.calls).toEqual([]);
    expect(m.entries.map((e) => e.action)).toEqual(['enter (sample, not applied)', 'exit (sample, not applied)']);
  });

  it('a sample that ends stays a sample, even when the source is already gone', async () => {
    const a = fake('a');
    const m = manager([a.integration]);
    await m.onState('focused', true);
    await m.tick();
    await m.onState('off', false);
    expect(a.calls).toEqual([]);
    expect(m.entries.at(-1)?.action).toBe('exit (sample, not applied)');
  });

  it('skips disabled and unconnected integrations', async () => {
    const off = fake('off');
    const notReady = fake('notReady', { ready: () => false });
    const m = manager([off.integration, notReady.integration], memoryStore(), () => false);
    await m.onState('focused', false);
    expect(off.calls).toEqual([]);
    expect(notReady.calls).toEqual([]);
  });

  it('undoes focus left behind by a crash, once', async () => {
    const store = memoryStore();
    const first = fake('a');
    await manager([first.integration], store).onState('focused', false);
    const second = fake('a');
    const m = manager([second.integration], store);
    await m.recoverFromCrash();
    await m.recoverFromCrash();
    expect(second.calls).toEqual(['exit']);
  });

  it('shutdown puts things back', async () => {
    const a = fake('a');
    const m = manager([a.integration]);
    await m.onState('focused', false);
    await m.shutdown();
    expect(a.calls).toEqual(['enter', 'exit']);
  });
});

describe('OS focus', () => {
  it('GNOME saves the setting, restores it, and is safe to call twice', async () => {
    const run = vi.fn(async (_f: string, args: string[]) => (args[0] === 'get' ? 'true\n' : ''));
    const gnome = new GnomeFocus(run, memoryStore());
    await gnome.onEnterFocus();
    await gnome.onEnterFocus();
    await gnome.onExitFocus();
    await gnome.onExitFocus();
    expect(run.mock.calls.map((c) => c[1].slice(0, 1).concat(c[1].slice(3)).join(' '))).toEqual(['get', 'set false', 'set true']);
  });

  it('GNOME leaves banners off if they were already off', async () => {
    const run = vi.fn(async (_f: string, args: string[]) => (args[0] === 'get' ? 'false\n' : ''));
    const gnome = new GnomeFocus(run, memoryStore());
    await gnome.onEnterFocus();
    await gnome.onExitFocus();
    expect(run.mock.calls.at(-1)?.[1].at(-1)).toBe('false');
  });

  it('macOS runs the two shortcuts and names any that are missing', async () => {
    const run = vi.fn(async () => 'FlowState On\n');
    const mac = new MacFocus(run, memoryStore());
    await mac.onEnterFocus();
    await mac.onExitFocus();
    expect(run.mock.calls).toEqual([
      ['shortcuts', ['run', 'FlowState On']],
      ['shortcuts', ['run', 'FlowState Off']],
    ]);
    expect((await mac.test()).detail).toContain('FlowState Off');
  });

  it('says plainly when a system has no supported way', async () => {
    const run = vi.fn(async () => '');
    const win = createOsFocus('win32', '', run, memoryStore());
    expect(win.ready()).toBe(false);
    expect((await win.test()).ok).toBe(false);
    expect(createOsFocus('linux', 'KDE', run, memoryStore()).ready()).toBe(false);
    expect(createOsFocus('linux', 'ubuntu:GNOME', run, memoryStore()).label).toContain('GNOME');
    expect(run).not.toHaveBeenCalled();
  });
});

type Call = { url: string; body: Record<string, unknown>; method: string };

describe('Slack', () => {
  function slack(profile: Record<string, unknown>, errors: Record<string, string> = {}) {
    const calls: Call[] = [];
    const current = { ...profile };
    const http = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const method = url.split('/').pop()!;
      calls.push({ url, body, method });
      if (errors[method]) return new Response(JSON.stringify({ ok: false, error: errors[method] }));
      if (method === 'users.profile.set') Object.assign(current, body.profile);
      return new Response(JSON.stringify({ ok: true, profile: current, team: 'T', user: 'U' }));
    }) as unknown as Fetch;
    const store = memoryStore();
    return { integration: new SlackIntegration(() => 'test-token', store, http), calls, current, store };
  }

  it('sets DND and status, then restores the old status', async () => {
    const s = slack({ status_text: 'Lunch', status_emoji: ':pizza:', status_expiration: 5 });
    await s.integration.onEnterFocus();
    expect(s.current.status_text).toBe('Focusing (FlowState)');
    await s.integration.onEnterFocus();
    await s.integration.onExitFocus();
    await s.integration.onExitFocus();
    expect(s.current).toMatchObject({ status_text: 'Lunch', status_emoji: ':pizza:', status_expiration: 5 });
    expect(s.calls.filter((c) => c.method === 'dnd.endSnooze').length).toBe(1);
  });

  it('leaves a status the user set during focus', async () => {
    const s = slack({ status_text: 'Lunch', status_emoji: '', status_expiration: 0 });
    await s.integration.onEnterFocus();
    s.current.status_text = 'In a meeting';
    await s.integration.onExitFocus();
    expect(s.current.status_text).toBe('In a meeting');
  });

  it('copes with a snooze that already ran out', async () => {
    const s = slack({ status_text: '' }, { 'dnd.endSnooze': 'snooze_not_active' });
    await s.integration.onEnterFocus();
    await expect(s.integration.onExitFocus()).resolves.toBeUndefined();
    expect(s.store.get('slack.savedStatus')).toBeUndefined();
  });

  it('keeps the saved status when restoring fails, so it can retry', async () => {
    const s = slack({ status_text: 'Lunch' }, { 'dnd.endSnooze': 'ratelimited' });
    await s.integration.onEnterFocus();
    await expect(s.integration.onExitFocus()).rejects.toThrow(/ratelimited/);
    expect(s.store.get('slack.savedStatus')).toBeDefined();
  });

  it('reports a bad token', async () => {
    const s = slack({}, { 'auth.test': 'invalid_auth' });
    expect(await s.integration.test()).toEqual({ ok: false, detail: 'Slack auth.test: invalid_auth' });
  });
});

describe('Google Calendar', () => {
  function gcal(start = 1_000_000_000_000) {
    let now = start;
    const calls: Call[] = [];
    let status = 200;
    let tokens: GoogleTokens = { accessToken: 'a1', refreshToken: 'r1', expiresAt: start + 3_600_000 };
    const http = (async (url: string, init: RequestInit) => {
      calls.push({ url, method: String(init.method), body: init.body && !url.includes('token') ? JSON.parse(String(init.body)) : {} });
      if (url.includes('oauth2.googleapis.com')) return new Response(JSON.stringify({ access_token: 'a2', expires_in: 3600 }));
      if (status !== 200) return new Response('{}', { status });
      return new Response(JSON.stringify({ id: 'ev1' }));
    }) as unknown as Fetch;
    const store = memoryStore();
    const integration = new GcalIntegration({
      getClient: () => ({ clientId: 'c', clientSecret: 's' }),
      getTokens: () => tokens,
      saveTokens: (t) => (tokens = t),
      store,
      http,
      now: () => now,
    });
    return { integration, calls, store, advance: (ms: number) => (now += ms), setStatus: (s: number) => (status = s), tokens: () => tokens };
  }
  const MIN = 60_000;

  it('creates one busy block, extends it, and ends it at exit', async () => {
    const g = gcal();
    await g.integration.onEnterFocus();
    await g.integration.onEnterFocus();
    expect(g.calls.length).toBe(1);
    expect(g.calls[0]!.body).toMatchObject({ summary: 'Focus time (FlowState)', transparency: 'opaque' });

    g.advance(5 * MIN);
    await g.integration.onStillFocused();
    expect(g.calls.length).toBe(1);
    g.advance(20 * MIN);
    await g.integration.onStillFocused();
    expect(g.calls.at(-1)!.method).toBe('PATCH');

    g.advance(5 * MIN);
    await g.integration.onExitFocus();
    expect(g.calls.at(-1)!.body).toEqual({ end: { dateTime: new Date(1_000_000_000_000 + 30 * MIN).toISOString() } });
    expect(g.store.get('gcal.event')).toBeUndefined();
  });

  it('deletes a block under a minute rather than leaving a sliver', async () => {
    const g = gcal();
    await g.integration.onEnterFocus();
    g.advance(10_000);
    await g.integration.onExitFocus();
    expect(g.calls.at(-1)!.method).toBe('DELETE');
  });

  it('after a crash, never moves the end later than planned', async () => {
    const g = gcal();
    await g.integration.onEnterFocus();
    g.advance(600 * MIN);
    await g.integration.onExitFocus();
    expect(g.calls.at(-1)!.body).toEqual({ end: { dateTime: new Date(1_000_000_000_000 + 30 * MIN).toISOString() } });
  });

  it('is fine if the user already deleted the event', async () => {
    const g = gcal();
    await g.integration.onEnterFocus();
    g.advance(5 * MIN);
    g.setStatus(404);
    await expect(g.integration.onExitFocus()).resolves.toBeUndefined();
    expect(g.store.get('gcal.event')).toBeUndefined();
  });

  it('refreshes an expiring token and saves it', async () => {
    const g = gcal();
    g.advance(3_590_000);
    await g.integration.onEnterFocus();
    expect(g.calls[0]!.url).toContain('oauth2.googleapis.com');
    expect(g.tokens().accessToken).toBe('a2');
    expect(g.tokens().refreshToken).toBe('r1');
  });
});

describe('rules', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });

  it('never posts to a channel', () => {
    for (const file of walk('src/integrations')) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/chat\.(post|schedule|me)|conversations\.|files\.upload/);
    }
  });
});
