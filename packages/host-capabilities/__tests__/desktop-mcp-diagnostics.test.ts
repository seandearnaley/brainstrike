import { parseConfiguredMcpServerId } from '@brainstrike/assistant-contract';
import { parseMcpConfigValue } from '@brainstrike/assistant-contract/mcp-config';
import {
  addLogListener,
  configureLogger,
  createLogger,
  LogLevel,
  type LogRecord,
} from '@brainstrike/logging';
import { describe, expect, it, vi } from 'vitest';
import type { MessageConnection } from 'vscode-jsonrpc';
import {
  createDesktopMcpDiagnostics,
  createDesktopNodeMcpHost,
  type DesktopNodeMcpHostOptions,
} from '../src/mcp/desktop-node-mcp.js';
import { reportStdioFailureDiagnostics } from '../src/mcp/host-connection.js';
import { McpHostRevisionPublisher } from '../src/mcp/host-revision-publisher.js';
import * as hostServices from '../src/mcp/mcp-host-services.js';
import { MCP_STORE_METHODS } from '../src/mcp/mcp-runtime-wire.js';
import { reportLoopbackListenerBound } from '../src/mcp/oauth-client-registration.js';
import { McpSettingsAuthority } from '../src/mcp/settings-authority.js';
import { McpStdioDiagnosticCollector } from '../src/mcp/stdio-diagnostics.js';

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
function stdioFailure(): void {
  const server = parseMcpConfigValue({
    servers: [
      { command: 'node', name: 'diagnostic-stdio', protocol: '2026-07-28', transport: 'stdio' },
    ],
  }).config.servers[0];
  if (!server) {
    throw new Error('Fixture server is missing');
  }
  const diagnostics = new McpStdioDiagnosticCollector();
  diagnostics.write(
    'Authorization: Bearer smoke-fake-long-bearer-secret https://auth.invalid/?code=smoke-fake-code\n'
  );
  reportStdioFailureDiagnostics(server, 7, diagnostics);
  reportStdioFailureDiagnostics(server, 7, diagnostics);
}

describe('desktop MCP diagnostic delivery', () => {
  it('forwards the canonical redacted record once and waits for its acknowledgement before the close receipt', async () => {
    configureLogger({ level: LogLevel.INFO });
    const acknowledgement = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const delivered: unknown[] = [];
    const request = vi.fn(async (method: string, payload: unknown) => {
      expect(method).toBe(MCP_STORE_METHODS.diagnostics);
      delivered.push(payload);
      if (delivered.length === 1) {
        entered.resolve();
        await acknowledgement.promise;
      }
    });
    const relay = createDesktopMcpDiagnostics(request);
    try {
      stdioFailure();
      createLogger('UnrelatedHost').warn('must not cross the MCP adapter');
      await entered.promise;
      let closed = false;
      const closing = relay.shutdown(report).then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);
      expect(delivered).toHaveLength(1);
      acknowledgement.resolve();
      await closing;
      expect(delivered).toHaveLength(2);
      expect(delivered[0]).toMatchObject({
        record: {
          args: [
            'MCP stdio failure diagnostics',
            {
              diagnostics: [
                {
                  message:
                    'Authorization: [redacted-secret:bearer-token] https://auth.invalid/?[redacted-query]',
                  stream: 'stderr',
                  truncated: false,
                },
              ],
              generation: 7,
              omittedDiagnostics: 0,
              server: 'diagnostic-stdio',
            },
          ],
          level: 'warn',
          scope: 'DesktopMcpHostConnection',
          timestamp: expect.any(Number),
        },
        type: 'record',
      });
      expect(JSON.stringify(delivered)).not.toContain('smoke-fake-long-bearer-secret');
      expect(JSON.stringify(delivered)).not.toContain('smoke-fake-code');
      expect(delivered[1]).toEqual({ hostCloseReport: report, type: 'shutdown' });
    } finally {
      acknowledgement.resolve();
      relay.dispose();
    }
  });

  it('preserves a reset receipt from the actual retirement report and continues observing the reopened owner', async () => {
    const request = vi.fn(async (_method: string, _payload: unknown) => undefined);
    const relay = createDesktopMcpDiagnostics(request);
    try {
      await relay.reset(report, { revision: 3, servers: [] });
      reportLoopbackListenerBound({ port: 12_345, reusedPersistedPort: true, server: 'oauth' });
      await relay.drain();
      expect(request.mock.calls.map((call) => call[1])).toMatchObject([
        { hostCloseReport: report, snapshot: { servers: [] }, type: 'reset' },
        {
          record: {
            args: [
              'MCP OAuth loopback callback listener bound',
              { port: 12_345, reusedPersistedPort: true, server: 'oauth' },
            ],
            scope: 'McpOAuthClientProvider',
          },
          type: 'record',
        },
      ]);
    } finally {
      relay.dispose();
    }
  });

  it('reports delivery failure loudly, retains it through drain, and unregisters its scoped tap', async () => {
    const failure = new Error('Main diagnostic adapter rejected delivery');
    const request = vi.fn(async (_method: string, _payload: unknown) => {
      throw failure;
    });
    const observed: LogRecord[] = [];
    const remove = addLogListener((record) => observed.push(record));
    const relay = createDesktopMcpDiagnostics(request);
    try {
      stdioFailure();
      await expect(relay.drain()).rejects.toThrow('MCP diagnostic delivery failed');
      expect(observed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ level: 'error', message: 'MCP diagnostic delivery failed' }),
        ])
      );
      await expect(relay.shutdown(report)).rejects.toThrow('MCP diagnostic delivery failed');
      relay.dispose();
      const count = request.mock.calls.length;
      stdioFailure();
      await Promise.resolve();
      expect(request).toHaveBeenCalledTimes(count);
    } finally {
      relay.dispose();
      remove();
    }
  });
});

function compositionOptions(
  request: DesktopNodeMcpHostOptions['request']
): DesktopNodeMcpHostOptions {
  const store = {
    delete: async () => false,
    join: async () => undefined,
    listAccounts: async () => [],
    read: async () => null,
    write: async () => undefined,
  };
  return {
    connection: { onRequest: () => ({ dispose: () => undefined }) } as unknown as MessageConnection,
    credentials: {
      secrets: () => ({ getKey: async () => null, listProviders: async () => [] }),
      store: () => store,
    },
    request,
    startup: {
      signal: new AbortController().signal,
      store: {
        getSetting: async () => undefined,
      } as unknown as DesktopNodeMcpHostOptions['startup']['store'],
    },
    userDataDir: '/disposable/mcp-diagnostic-test-profile',
  };
}

describe('desktop MCP composition receipts', () => {
  it('retires Settings callbacks while the existing status stream remains owned by runtime shutdown', async () => {
    const publisher = new McpHostRevisionPublisher({
      onDiagnostic: (_diagnostic, cause) => {
        throw cause;
      },
    });
    const watch = vi.spyOn(publisher, 'watch');
    const services = {
      close: async () => ({ ...report, subscriptionsClosed: publisher.close() }),
      runtime: {
        host: { snapshot: () => publisher.snapshot(), watch: publisher.watch.bind(publisher) },
      },
    } as unknown as hostServices.McpHostServices;
    const create = vi.spyOn(hostServices, 'createMcpHostServices').mockResolvedValue(services);
    const start = vi.spyOn(McpSettingsAuthority.prototype, 'start').mockResolvedValue();
    const request = vi.fn(async (_method: string, _payload: unknown) => undefined);
    const host = await createDesktopNodeMcpHost(compositionOptions(request));
    const first = vi.fn();
    const second = vi.fn();
    const server = {
      configuredProtocol: '2026-07-28' as const,
      configuredServerId: parseConfiguredMcpServerId('watch-lifetime'),
      generation: 1,
      state: 'disconnected' as const,
      transport: 'stdio' as const,
    };
    try {
      const stopFirst = host.settings.subscribe(first);
      publisher.publishConfigSet([server]);
      await Promise.resolve();
      expect(first).toHaveBeenCalledOnce();
      stopFirst();
      publisher.publishConfigSet([]);
      await Promise.resolve();
      expect(first).toHaveBeenCalledOnce();
      const stopSecond = host.settings.subscribe(second);
      expect(watch).toHaveBeenCalledOnce();
      publisher.publishConfigSet([server]);
      await Promise.resolve();
      expect(second).toHaveBeenCalledOnce();
      stopSecond();
      publisher.publishConfigSet([]);
      const third = vi.fn();
      const stopThird = host.settings.subscribe(third);
      await Promise.resolve();
      expect(third).not.toHaveBeenCalled(); // a queued revision predates this callback
      stopThird();
      await host.close();
      expect(first).toHaveBeenCalledOnce();
      expect(second).toHaveBeenCalledOnce();
      expect(request.mock.calls[1]?.[1]).toEqual({
        hostCloseReport: { ...report, subscriptionsClosed: 1 },
        type: 'shutdown',
      });
      expect(publisher.close()).toBe(0);
    } finally {
      await host.close();
      create.mockRestore();
      start.mockRestore();
    }
  });

  it('joins physical shutdown and Main acknowledgement before returning, then unregisters the tap', async () => {
    const joined = Promise.withResolvers<typeof report>();
    const acknowledged = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const services = {
      close: vi.fn(() => joined.promise),
      runtime: { host: {} },
    } as unknown as hostServices.McpHostServices;
    const create = vi.spyOn(hostServices, 'createMcpHostServices').mockResolvedValue(services);
    const start = vi.spyOn(McpSettingsAuthority.prototype, 'start').mockResolvedValue();
    const request = vi.fn(async (method: string, _payload: unknown) => {
      if (method === MCP_STORE_METHODS.diagnostics) {
        entered.resolve();
        await acknowledged.promise;
      }
    });
    const host = await createDesktopNodeMcpHost(compositionOptions(request));
    let completed = false;
    const closing = host.close().then(() => {
      completed = true;
    });
    try {
      await vi.waitFor(() => expect(services.close).toHaveBeenCalledOnce());
      expect(request).toHaveBeenCalledTimes(1); // ready, no receipt before physical join
      joined.resolve(report);
      await entered.promise;
      expect(completed).toBe(false);
      expect(request.mock.calls[1]?.[1]).toEqual({ hostCloseReport: report, type: 'shutdown' });
      acknowledged.resolve();
      await closing;
      expect(completed).toBe(true);
      stdioFailure();
      await Promise.resolve();
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      joined.resolve(report);
      acknowledged.resolve();
      await host.close();
      create.mockRestore();
      start.mockRestore();
    }
  });

  it('reads the canonical retired report and snapshot only after settings reset joins', async () => {
    const resetJoined = Promise.withResolvers<void>();
    const snapshot = { revision: 4, servers: [] };
    const retiredCleanupReport = vi.fn(() => report);
    const services = {
      close: async () => report,
      runtime: { host: { snapshot: () => snapshot }, retiredCleanupReport },
    } as unknown as hostServices.McpHostServices;
    const create = vi.spyOn(hostServices, 'createMcpHostServices').mockResolvedValue(services);
    const start = vi.spyOn(McpSettingsAuthority.prototype, 'start').mockResolvedValue();
    const reset = vi
      .spyOn(McpSettingsAuthority.prototype, 'reset')
      .mockImplementation(() => resetJoined.promise);
    const request = vi.fn(async (_method: string, _payload: unknown) => undefined);
    const host = await createDesktopNodeMcpHost(compositionOptions(request));
    try {
      const resetting = host.settings.reset();
      expect(retiredCleanupReport).not.toHaveBeenCalled();
      resetJoined.resolve();
      await resetting;
      expect(retiredCleanupReport).toHaveBeenCalledOnce();
      expect(request.mock.calls[1]?.[1]).toEqual({
        hostCloseReport: report,
        snapshot,
        type: 'reset',
      });
    } finally {
      resetJoined.resolve();
      await host.close();
      create.mockRestore();
      start.mockRestore();
      reset.mockRestore();
    }
  });

  it('refuses a successful receipt after physical cleanup fails and unregisters the tap', async () => {
    const services = {
      close: async () => {
        throw new Error('physical MCP cleanup failed');
      },
      runtime: { host: {} },
    } as unknown as hostServices.McpHostServices;
    const create = vi.spyOn(hostServices, 'createMcpHostServices').mockResolvedValue(services);
    const start = vi.spyOn(McpSettingsAuthority.prototype, 'start').mockResolvedValue();
    const request = vi.fn(async (_method: string, _payload: unknown) => undefined);
    const host = await createDesktopNodeMcpHost(compositionOptions(request));
    try {
      await expect(host.close()).rejects.toThrow('Desktop MCP host cleanup failed');
      expect(request).toHaveBeenCalledTimes(1);
      stdioFailure();
      await Promise.resolve();
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      create.mockRestore();
      start.mockRestore();
    }
  });
});
