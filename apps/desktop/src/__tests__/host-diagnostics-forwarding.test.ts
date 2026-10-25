// @vitest-environment node

import { randomUUID } from 'node:crypto';
import {
  addLogListener,
  configureLogger,
  createLogger,
  LogLevel,
  type LogRecord,
} from '@brainstrike/logging';
import { afterEach, describe, expect, it } from 'vitest';
import type { CancellationToken, MessageConnection } from 'vscode-jsonrpc';
import { forwardHostDiagnostics } from '../agent-host-platform/host-diagnostics';
import {
  type DesktopPlatformCapabilities,
  serveDesktopPlatform,
} from '../agent-host-platform/main-platform';
import { PLATFORM_DIAGNOSTICS_RECORD_METHOD } from '../agent-host-platform/platform-wire';

interface Forwarded {
  readonly record: LogRecord;
}

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
});

function forwarding(send: (record: unknown) => Promise<unknown>) {
  const tap = forwardHostDiagnostics(send);
  closers.push(() => tap.stop());
  return tap;
}

describe('agent host diagnostic forwarding (BST-2202)', () => {
  it('delivers an error record with its correlation id, redacted, and leaves other records to stderr', async () => {
    configureLogger({ level: LogLevel.INFO });
    const sent: Forwarded[] = [];
    const tap = forwarding(async (record) => {
      sent.push(record as Forwarded);
      return null;
    });
    const correlationId = randomUUID();
    const logger = createLogger('AgentHost');
    logger.info('An ordinary record stays on the host');
    logger.warn('A warning stays on the host');
    logger.error('Assistant model attempt failed', {
      apiKey: 'sk-fixture-forwarding-secret-0123456789',
      cause: new Error('Recorded embedder failure'),
      code: 'memory.embedder-failed',
      correlationId,
      runId: 'run-1',
      threadId: 'thread-1',
    });
    // MCP's own tap forwards its scopes; its delivery logger and this one stay local.
    createLogger('McpHostRuntime').error('MCP record');
    createLogger('DesktopMcpDiagnosticDelivery').error('MCP delivery failed');
    createLogger('DesktopHostDiagnosticDelivery').error('Delivery failed');
    tap.stop();

    expect(sent).toHaveLength(1);
    const [forwarded] = sent;
    expect(forwarded?.record).toMatchObject({
      level: 'error',
      message: 'Assistant model attempt failed',
      scope: 'AgentHost',
    });
    expect(forwarded?.record.args[1]).toMatchObject({
      cause: { message: 'Recorded embedder failure', name: 'Error' },
      code: 'memory.embedder-failed',
      correlationId,
      runId: 'run-1',
      threadId: 'thread-1',
    });
    // No secret crosses: the producer's redaction holds on the wire.
    expect(JSON.stringify(sent)).not.toContain('sk-fixture-forwarding-secret');
  });

  it('reports a failed delivery on the host only, once', async () => {
    configureLogger({ level: LogLevel.INFO });
    const records: LogRecord[] = [];
    closers.push(addLogListener((record) => records.push(record)));
    let attempts = 0;
    let delivery: Promise<unknown> = Promise.resolve();
    forwarding(() => {
      attempts += 1;
      delivery = Promise.reject(new Error('Main connection closed'));
      return delivery;
    });
    createLogger('AgentHost').error('Run failed', { correlationId: randomUUID() });
    // The tap's own handler was attached first, so it has run once this settles.
    await delivery.catch(() => undefined);
    // The delivery failure is logged, and never itself forwarded again.
    expect(attempts).toBe(1);
    expect(
      records.filter((record) => record.scope === 'DesktopHostDiagnosticDelivery')
    ).toHaveLength(1);
  });

  it('stops forwarding once stopped', () => {
    const sent: unknown[] = [];
    const tap = forwarding(async (record) => {
      sent.push(record);
      return null;
    });
    tap.stop();
    createLogger('AgentHost').error('After stop');
    expect(sent).toEqual([]);
  });
});

describe("Main's diagnostics for forwarded agent host records (BST-2202)", () => {
  function main() {
    const handlers = new Map<string, (input: unknown, token: CancellationToken) => unknown>();
    const connection = {
      dispose: () => undefined,
      listen: () => undefined,
      onClose: () => ({ dispose: () => undefined }),
      onDispose: () => ({ dispose: () => undefined }),
      onNotification: () => ({ dispose: () => undefined }),
      onRequest: (
        method: string,
        handler: (input: unknown, token: CancellationToken) => unknown
      ) => {
        handlers.set(method, handler);
        return { dispose: () => handlers.delete(method) };
      },
    } as unknown as MessageConnection;
    const owner = serveDesktopPlatform(connection, {
      admission: {},
      mcp: { control: { bind: () => ({ close: () => undefined, ready: () => undefined }) } },
    } as unknown as DesktopPlatformCapabilities);
    closers.push(() => owner.close());
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose: () => undefined }),
    } as unknown as CancellationToken;
    return async (input: unknown) => {
      const handler = handlers.get(PLATFORM_DIAGNOSTICS_RECORD_METHOD);
      if (!handler) {
        throw new Error('Main does not serve forwarded agent host records');
      }
      return await handler(input, token);
    };
  }

  it('writes the record through its own scope into the logger that owns the durable sinks', async () => {
    configureLogger({ level: LogLevel.INFO });
    const send = main();
    const records: LogRecord[] = [];
    closers.push(addLogListener((record) => records.push(record)));
    const correlationId = randomUUID();
    const args = [
      'Assistant model attempt failed',
      { code: 'memory.observer-failed', correlationId, runId: 'run-1', threadId: 'thread-1' },
    ];
    await expect(
      send({
        record: {
          args,
          bindings: {},
          level: 'error',
          message: 'Assistant model attempt failed',
          scope: 'AgentHost',
          timestamp: 1,
        },
      })
    ).resolves.toBeNull();
    expect(records).toEqual([
      expect.objectContaining({ args, level: LogLevel.ERROR, scope: 'AgentHost' }),
    ]);
  });

  it.each([
    { args: ['a warning'], bindings: {}, level: 'warn', scope: 'AgentHost', timestamp: 1 },
    { args: ['no level'], bindings: {}, scope: 'AgentHost', timestamp: 1 },
    { args: ['extra'], bindings: {}, level: 'error', scope: 'AgentHost', stack: 'x', timestamp: 1 },
  ])('refuses a record outside the error contract without logging it: %j', async (record) => {
    const send = main();
    const records: LogRecord[] = [];
    closers.push(addLogListener((logged) => records.push(logged)));
    await expect(send({ record })).rejects.toThrow();
    expect(records.filter((logged) => logged.scope === 'AgentHost')).toEqual([]);
  });
});
