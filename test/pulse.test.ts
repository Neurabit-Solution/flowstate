import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PulseCore, type HeldMessage } from '../src/mcp/core';
import { startPulseHttp, type PulseHttp } from '../src/mcp/http';

const TOKEN = 'test-token-for-this-suite';
const parse = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0]!.text) as Record<string, unknown>;

describe('Pulse rules', () => {
  const at = (state: Parameters<PulseCore['update']>[0]) => {
    const core = new PulseCore();
    core.update(state);
    return core;
  };

  it.each(['focused', 'talking'] as const)('while %s, only urgent gets through', async (state) => {
    const core = at(state);
    expect((await core.shouldInterrupt('low')).allow).toBe(false);
    expect((await core.shouldInterrupt('normal')).allow).toBe(false);
    expect((await core.shouldInterrupt('urgent')).allow).toBe(true);
  });

  it('while away, nothing gets through', async () => {
    expect((await at('away').shouldInterrupt('urgent')).allow).toBe(false);
  });

  it.each(['available', 'off', 'warming_up'] as const)('while %s, everything gets through', async (state) => {
    expect((await at(state).shouldInterrupt('low')).allow).toBe(true);
  });

  it('holds messages during focus and delivers them when available', async () => {
    const delivered: HeldMessage[][] = [];
    const core = new PulseCore({ onDeliver: (m) => delivered.push(m) });
    core.update('focused');
    await core.queueMessage('one', 'low', 'agent');
    await core.queueMessage('two', 'normal', 'agent');
    expect((await core.getDevState()).heldMessages).toBe(2);
    core.update('talking');
    core.update('away');
    expect(delivered).toEqual([]);
    core.update('available');
    expect(delivered[0]!.map((m) => m.text)).toEqual(['one', 'two']);
    expect((await core.getDevState()).heldMessages).toBe(0);
  });

  it('limits what the queue accepts', async () => {
    const core = at('focused');
    expect((await core.queueMessage('   ', 'low', 'a')).queued).toBe(false);
    await core.queueMessage('x'.repeat(5000), 'low', 'a');
    expect(core.heldList[0]!.text.length).toBe(2000);
    for (let i = 0; i < 120; i += 1) await core.queueMessage('m', 'low', 'a');
    expect(core.heldList.length).toBe(100);
  });

  it('wait wakes when the user is free, and otherwise times out', async () => {
    vi.useFakeTimers();
    try {
      const core = at('focused');
      const woken = core.waitUntilAvailable(60);
      core.update('available');
      expect(await woken).toEqual({ available: true, state: 'available' });
      core.update('focused');
      const timedOut = core.waitUntilAvailable(60);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await timedOut).toEqual({ available: false, state: 'focused' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts focus minutes, including a block still going, and today only', async () => {
    let now = 10 * 24 * 60 * 60_000;
    const MIN = 60_000;
    const core = new PulseCore({ now: () => now, startOfDay: (ms) => ms - (ms % (24 * 60 * MIN)) });
    core.update('focused');
    now += 30 * MIN;
    core.update('available');
    now += 10 * MIN;
    core.update('focused');
    now += 20 * MIN;
    expect((await core.getDevState()).focusMinutesToday).toBe(50);
    expect(await core.getFocusSummary('today')).toMatchObject({ focusMinutes: 50, blocks: 2, longestBlockMinutes: 30 });
    core.update('available');
    now += 24 * 60 * MIN;
    expect((await core.getDevState()).focusMinutesToday).toBe(0);
    expect((await core.getFocusSummary('7d')).focusMinutes).toBeGreaterThanOrEqual(50);
  });

  it('exposes only the allowed fields', async () => {
    expect(Object.keys(await at('focused').getDevState()).sort()).toEqual(['focusMinutesToday', 'heldMessages', 'since', 'state']);
  });

  it('imports nothing from the signal module', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        return statSync(p).isDirectory() ? walk(p) : [p];
      });
    for (const file of walk('src/mcp')) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/signals\/|@smartspectra|upperTrace|breathing/);
    }
  });
});

describe('over HTTP with the official MCP client', () => {
  let core: PulseCore;
  let http: PulseHttp;
  let client: Client;
  const url = () => `http://127.0.0.1:${http.port}/mcp`;

  beforeAll(async () => {
    core = new PulseCore({ onChange: () => http?.notifyChanged() });
    http = await startPulseHttp(core, TOKEN, '0.0.1');
    client = new Client({ name: 'test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url()), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
  });
  afterAll(async () => {
    await client.close();
    await http.close();
  });

  const post = (headers: Record<string, string>) =>
    fetch(url(), { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body: '{}' });

  it('lists the spec tools and the resource', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['get_dev_state', 'get_focus_summary', 'queue_message', 'should_interrupt', 'wait_until_available']);
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toEqual(['devstate://current']);
  });

  it('runs the flow an agent follows', async () => {
    core.update('focused');
    const answer = parse(await client.callTool({ name: 'should_interrupt', arguments: { priority: 'normal', reason: 'which test db?' } }));
    expect(answer.allow).toBe(false);
    const queued = parse(await client.callTool({ name: 'queue_message', arguments: { text: 'which test db?', priority: 'normal', source: 'test' } }));
    expect(queued).toMatchObject({ queued: true, heldMessages: 1 });
    const state = parse(await client.callTool({ name: 'get_dev_state', arguments: {} }));
    expect(state).toMatchObject({ state: 'focused', heldMessages: 1 });
    core.update('available');
  });

  it('rejects invalid input', async () => {
    const result = (await client.callTool({ name: 'should_interrupt', arguments: { priority: 'please', reason: 'x' } })) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });

  it('notifies subscribers when the state changes', async () => {
    const updated = new Promise<string>((resolve) => {
      client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => resolve(n.params.uri));
    });
    await client.subscribeResource({ uri: 'devstate://current' });
    core.update('talking');
    expect(await updated).toBe('devstate://current');
    const read = await client.readResource({ uri: 'devstate://current' });
    expect(JSON.parse((read.contents[0] as { text: string }).text).state).toBe('talking');
    core.update('available');
  });

  it('refuses a missing or wrong token', async () => {
    expect((await post({})).status).toBe(401);
    expect((await post({ Authorization: 'Bearer nope' })).status).toBe(401);
  });

  it('refuses requests from a web page', async () => {
    expect((await post({ Authorization: `Bearer ${TOKEN}`, Origin: 'https://evil.example' })).status).toBe(403);
  });

  it('listens on loopback only', async () => {
    const { networkInterfaces } = await import('node:os');
    const outside = Object.values(networkInterfaces()).flat().find((i) => i && !i.internal && i.family === 'IPv4');
    if (!outside) return;
    await expect(fetch(`http://${outside.address}:${http.port}/mcp`)).rejects.toThrow();
  });
});

describe('over stdio, as an agent launches it', () => {
  let dir: string;
  let script: string;
  let connectionFile: string;

  const connect = async () => {
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [script], env: { FLOWSTATE_PULSE_FILE: connectionFile, PATH: process.env.PATH ?? '' } }));
    return client;
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pulse-'));
    script = join(dir, 'stdio.js');
    connectionFile = join(dir, 'pulse.json');
    await build({ entryPoints: ['src/mcp/stdio.ts'], outfile: script, bundle: true, platform: 'node', format: 'cjs', target: 'node20', logLevel: 'silent' });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('does not block an agent when the app is closed', async () => {
    const client = await connect();
    try {
      expect(parse(await client.callTool({ name: 'get_dev_state', arguments: {} }))).toMatchObject({ state: 'off' });
      expect(parse(await client.callTool({ name: 'should_interrupt', arguments: { priority: 'low', reason: 'x' } }))).toMatchObject({ allow: true });
      expect(parse(await client.callTool({ name: 'queue_message', arguments: { text: 'hi', priority: 'low', source: 't' } }))).toMatchObject({ queued: false });
    } finally {
      await client.close();
    }
  });

  it('reaches the running app', async () => {
    const core = new PulseCore();
    const http = await startPulseHttp(core, TOKEN, '0.0.1');
    writeFileSync(connectionFile, JSON.stringify({ port: http.port, token: TOKEN }));
    core.update('focused');
    const client = await connect();
    try {
      expect(parse(await client.callTool({ name: 'should_interrupt', arguments: { priority: 'low', reason: 'x' } }))).toMatchObject({ allow: false });
      await client.callTool({ name: 'queue_message', arguments: { text: 'from stdio', priority: 'low', source: 't' } });
      expect(core.heldList.map((m) => m.text)).toEqual(['from stdio']);
    } finally {
      await client.close();
      await http.close();
    }
  });
});
