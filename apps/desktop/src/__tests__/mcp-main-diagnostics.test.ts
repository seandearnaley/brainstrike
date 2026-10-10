// @vitest-environment node

import { MCP_STORE_METHODS } from '@brainstrike/host-capabilities/mcp/mcp-runtime-wire';
import { addLogListener, LogLevel, type LogRecord } from '@brainstrike/logging';
import { expect, it, vi } from 'vitest';
import type { MessageConnection } from 'vscode-jsonrpc';
import { serveMainMcpStores } from '../agent-host-platform/mcp-main-stores';
import type { MainMcpHostControl } from '../mcp/main-host-control';

const report = {
  callbacksClosed: 2,
  childProcessesClosed: 1,
  clientsClosed: 1,
  failures: [],
  loopbackPortsClosed: 1,
  probesClosed: 0,
  requestsSettled: 3,
  subscriptionsClosed: 0,
};
function harness() {
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
  const connection = {
    onRequest: (method: string, handler: (input: unknown) => Promise<unknown>) => {
      handlers.set(method, handler);
      return { dispose: () => handlers.delete(method) };
    },
  } as unknown as MessageConnection;
  const control = {
    bind: () => ({ close: vi.fn(), ready: vi.fn() }),
  } as unknown as MainMcpHostControl;
  const owner = serveMainMcpStores(connection, { control, openExternal: async () => undefined });
  expect(
    handlers.has(MCP_STORE_METHODS.diagnostics),
    'private MCP diagnostic request must be served'
  ).toBe(true);
  const records: LogRecord[] = [];
  const remove = addLogListener((record) => records.push(record));
  return {
    close: () => {
      owner.close();
      remove();
    },
    records,
    send: async (input: unknown) => {
      const handler = handlers.get(MCP_STORE_METHODS.diagnostics);
      return await handler?.(input);
    },
  };
}
it('emits typed MCP records and real shutdown/reset receipts through the existing Main logger', async () => {
  const h = harness();
  try {
    const record: LogRecord = {
      args: [
        'MCP stdio failure diagnostics',
        {
          diagnostics: [
            { message: '[redacted-secret:bearer-token]', stream: 'stderr', truncated: false },
          ],
          generation: 7,
          omittedDiagnostics: 0,
          server: 'diagnostic-stdio',
        },
      ],
      bindings: {},
      level: LogLevel.WARN,
      message: 'MCP stdio failure diagnostics',
      scope: 'DesktopMcpHostConnection',
      timestamp: 123,
    };
    await h.send({ record, type: 'record' });
    await h.send({ hostCloseReport: report, type: 'shutdown' });
    await h.send({
      hostCloseReport: report,
      snapshot: { revision: 3, servers: [] },
      type: 'reset',
    });
    expect(h.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          args: record.args,
          level: LogLevel.WARN,
          scope: 'DesktopMcpHostConnection',
        }),
        expect.objectContaining({
          args: [
            'MCP runtime shutdown cleanup completed',
            { hostCloseReport: report, legacyClientsClosed: true },
          ],
          message: 'MCP runtime shutdown cleanup completed',
        }),
        expect.objectContaining({
          args: [
            'MCP runtime reset cleanup completed',
            {
              hostCloseReport: report,
              legacyClientsClosed: true,
              snapshot: { revision: 3, servers: [] },
            },
          ],
          message: 'MCP runtime reset cleanup completed',
        }),
      ])
    );
  } finally {
    h.close();
  }
});
it.each([
  {
    record: {
      args: ['not MCP'],
      bindings: {},
      level: 'warn',
      scope: 'UnrelatedHost',
      timestamp: 1,
    },
    type: 'record',
  },
  {
    record: {
      args: ['invalid level'],
      bindings: {},
      level: 'invalid',
      scope: 'DesktopMcpHostConnection',
      timestamp: 1,
    },
    type: 'record',
  },
  { hostCloseReport: { ...report, clientsClosed: -1 }, type: 'shutdown' },
  {
    hostCloseReport: {
      ...report,
      failures: [{ category: 'transport', code: 'mcp-child-exited', message: 'not joined' }],
    },
    type: 'shutdown',
  },
  { hostCloseReport: report, snapshot: { servers: 'invalid' }, type: 'reset' },
])('rejects malformed/unrelated diagnostic delivery without logging success: %j', async (input) => {
  const h = harness();
  try {
    await expect(h.send(input)).rejects.toThrow();
    expect(h.records).toEqual([]);
  } finally {
    h.close();
  }
});
