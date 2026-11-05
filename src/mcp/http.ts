// Local HTTP server for Pulse. Bound to 127.0.0.1 only, and every request needs the install's
// bearer token. The Host and Origin checks stop a web page from reaching it through the browser.
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { PulseBackend, Priority, SummaryRange } from './core';
import { createPulseServer, RESOURCE_URI, type PulseServer } from './tools';

const MAX_BODY = 64 * 1024;

export type PulseHttp = { port: number; notifyChanged(): void; close(): Promise<void> };

function tokenMatches(header: string | undefined, token: string): boolean {
  const given = Buffer.from(header ?? '');
  const want = Buffer.from(`Bearer ${token}`);
  return given.length === want.length && timingSafeEqual(given, want);
}

function isLocalOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === '127.0.0.1' || hostname === 'localhost';
  } catch {
    return false;
  }
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
};

type Session = { transport: StreamableHTTPServerTransport; pulse: PulseServer };

export async function startPulseHttp(backend: PulseBackend, token: string, version: string): Promise<PulseHttp> {
  const sessions = new Map<string, Session>();
  let port = 0;

  const rpc = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    switch (name) {
      case 'getDevState':
        return backend.getDevState();
      case 'shouldInterrupt':
        return backend.shouldInterrupt(args.priority as Priority, String(args.reason ?? ''));
      case 'queueMessage':
        return backend.queueMessage(String(args.text ?? ''), args.priority as Priority, String(args.source ?? ''));
      case 'waitUntilAvailable':
        return backend.waitUntilAvailable(Number(args.timeoutSeconds ?? 0));
      case 'getFocusSummary':
        return backend.getFocusSummary(args.range as SummaryRange);
      default:
        throw new Error('Unknown method');
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const hostOk = req.headers.host === `127.0.0.1:${port}` || req.headers.host === `localhost:${port}`;
    if (!hostOk || !isLocalOrigin(req.headers.origin)) return send(res, 403, { error: 'Forbidden' });
    if (!tokenMatches(req.headers.authorization, token)) return send(res, 401, { error: 'Unauthorized' });

    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (path.startsWith('/rpc/') && req.method === 'POST') {
      const args = ((await readBody(req)) ?? {}) as Record<string, unknown>;
      return send(res, 200, await rpc(path.slice('/rpc/'.length), args));
    }
    if (path !== '/mcp') return send(res, 404, { error: 'Not found' });

    const sessionId = req.headers['mcp-session-id'];
    const existing = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
    const body = req.method === 'POST' ? await readBody(req) : undefined;
    if (existing) {
      await existing.transport.handleRequest(req, res, body);
      return;
    }
    if (sessionId) return send(res, 404, { error: 'Unknown session' });

    const pulse = createPulseServer(backend, version);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (id) => void sessions.set(id, { transport, pulse }),
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await pulse.server.connect(transport);
    await transport.handleRequest(req, res, body);
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, { error: 'Internal error' });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  port = (server.address() as AddressInfo).port;

  return {
    port,
    notifyChanged() {
      for (const { pulse } of sessions.values()) {
        if (pulse.subscribed()) void pulse.server.server.sendResourceUpdated({ uri: RESOURCE_URI }).catch(() => undefined);
      }
    },
    async close() {
      for (const { transport } of sessions.values()) await transport.close().catch(() => undefined);
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
