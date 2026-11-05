import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { PulseBackend } from './core';

export const RESOURCE_URI = 'devstate://current';

const priority = z.enum(['low', 'normal', 'urgent']);
const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> });

export type PulseServer = { server: McpServer; subscribed: () => boolean };

export function createPulseServer(backend: PulseBackend, version: string): PulseServer {
  const server = new McpServer(
    { name: 'flowstate-pulse', version },
    {
      capabilities: { resources: { subscribe: true } },
      instructions:
        'Tells you whether the user is available. Before asking a non-blocking question, call should_interrupt. If it says no, call queue_message and keep working. Summarize when the user returns.',
    },
  );

  server.registerTool(
    'get_dev_state',
    { description: 'Current state (off, warming_up, away, talking, available, focused), since when, focus minutes today, and how many messages are held.', inputSchema: {} },
    async () => json(await backend.getDevState()),
  );
  server.registerTool(
    'should_interrupt',
    {
      description: 'Ask before interrupting the user. While focused or talking, only urgent is allowed. While away, nothing is, so queue it.',
      inputSchema: { priority, reason: z.string().max(500).describe('Why you want to interrupt. Not stored.') },
    },
    async ({ priority: p, reason }) => json(await backend.shouldInterrupt(p, reason)),
  );
  server.registerTool(
    'queue_message',
    {
      description: 'Hold a message for the user. It appears as a desktop notification when they become available.',
      inputSchema: { text: z.string().max(2000), priority, source: z.string().max(100).describe('Your name, such as claude-code.') },
    },
    async ({ text, priority: p, source }) => json(await backend.queueMessage(text, p, source)),
  );
  server.registerTool(
    'wait_until_available',
    { description: 'Wait until the user is available, or for the timeout. At most 300 seconds per call.', inputSchema: { timeoutSeconds: z.number().min(0).max(300) } },
    async ({ timeoutSeconds }) => json(await backend.waitUntilAvailable(timeoutSeconds)),
  );
  server.registerTool(
    'get_focus_summary',
    { description: 'Focus minutes and blocks for today or the last 7 days.', inputSchema: { range: z.enum(['today', '7d']) } },
    async ({ range }) => json(await backend.getFocusSummary(range)),
  );

  server.registerResource('dev-state', RESOURCE_URI, { description: 'The current dev state. Subscribe to hear when it changes.', mimeType: 'application/json' }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await backend.getDevState()) }],
  }));

  let subscribed = false;
  server.server.setRequestHandler(SubscribeRequestSchema, async () => {
    subscribed = true;
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async () => {
    subscribed = false;
    return {};
  });

  return { server, subscribed: () => subscribed };
}
