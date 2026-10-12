import { randomUUID } from 'node:crypto';
import { validateMcpElicitationResult } from '@brainstrike/agent/mcp-client';
import { startAgentHost } from '@brainstrike/agent-host';
import { scriptedModel } from '@brainstrike/agent-host/test-fixtures/scripted-model';
import {
  DEFAULT_PERMISSION_POLICIES,
  parseConfiguredMcpServerId,
} from '@brainstrike/assistant-contract';
import { configureLogger } from '@brainstrike/logging';
import { z } from 'zod';

configureLogger({ console: false });
let host;
let starting;
let closing;
const send = (message) => process.send?.(message);
const lifetime = new AbortController();
const cancelled = Promise.withResolvers();
cancelled.promise.catch(() => undefined);
lifetime.signal.addEventListener('abort', () => cancelled.reject(lifetime.signal.reason), {
  once: true,
});
const close = () => {
  lifetime.abort(new Error('GUI fixture startup cancelled'));
  closing ??= (async () => {
    const startup = await Promise.allSettled([starting]);
    const owner = await Promise.allSettled([host?.close()]);
    const failures = [...startup, ...owner]
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, 'GUI fixture startup and owner cleanup failed');
    }
    if (process.connected) {
      process.disconnect();
    }
  })();
  return closing;
};

async function start(input) {
  const { root, secret, mode, unknown, holdStartup } = z
    .object({
      holdStartup: z.boolean().optional(),
      mode: z.enum(['form', 'url']),
      root: z.string(),
      secret: z.string(),
      unknown: z.boolean(),
    })
    .parse(input);
  const ready = Promise.withResolvers();
  ready.promise.catch(() => undefined);
  const response = Promise.withResolvers();
  response.promise.catch(() => undefined);
  const id = randomUUID();
  const serverId = parseConfiguredMcpServerId('recorded.gui.server');
  const params =
    mode === 'form'
      ? {
          message: secret,
          mode,
          requestedSchema: {
            properties: { workspace: { title: 'Workspace', type: 'string' } },
            required: ['workspace'],
            type: 'object',
          },
        }
      : { message: 'Recorded URL input', mode, url: `https://example.test/${secret}` };
  const request = { method: 'elicitation/create', params };
  const presentation = {
    id,
    ...params,
    provenance: {
      configuredProtocol: '2026-07-28',
      configuredServerId: serverId,
      generation: 7,
      invocationId: randomUUID(),
      negotiatedRevision: '2026-07-28',
      operation: { type: 'tools/call' },
      requestId: 'recorded-gui-request-1',
      transport: 'streamable-http',
    },
  };
  host = await startAgentHost(
    { lifetime: 'persistent', root },
    async (startup) => {
      if (holdStartup) {
        send({ type: 'startup-held' });
        await cancelled.promise;
      }
      startup.signal.throwIfAborted();
      return {
        close: async () => undefined,
        maxSteps: 3,
        readPermissionPolicy: () => ({
          policies: { ...DEFAULT_PERMISSION_POLICIES, mcp: 'allow' },
          yolo: true,
        }),
        resolveModel: async () => scriptedModel('mcp_fixture'),
        tools: {
          mcp_fixture: {
            description: 'Recorded native form request',
            execute: async (_input, context) => {
              const abort = () => response.reject(new Error('Recorded caller stopped'));
              context.signal.addEventListener('abort', abort, { once: true });
              try {
                if (!context.mcp) {
                  throw new Error('Recorded executor has no Core input owner');
                }
                await context.mcp.requestInput({
                  assertCurrent: async () => context.signal.throwIfAborted(),
                  presentation,
                  settle: async (answer) => {
                    send({ answer, type: 'delivered' });
                    response.resolve({ accepted: true });
                    return unknown ? 'unknown' : 'local-finalized';
                  },
                  signal: context.signal,
                  validate: async (answer) => validateMcpElicitationResult(request, answer),
                });
                ready.resolve();
                return await response.promise;
              } catch (cause) {
                ready.reject(cause);
                throw cause;
              } finally {
                context.signal.removeEventListener('abort', abort);
              }
            },
            identity: 'recorded-gui-executor-7',
            inputSchema: z.object({ text: z.string() }),
            mcpAuthority: {
              auth: { type: 'none' },
              destination: 'http://127.0.0.1:1/mcp',
              extensions: { apps: true, tasks: true },
              kind: 'http',
              protocol: '2026-07-28',
              transport: 'streamable-http',
              version: 1,
            },
            mcpBinding: { configuredServerId: serverId, generation: 7 },
            risk: 'mcp',
          },
        },
      };
    },
    lifetime.signal
  );
  const { threadId } = await host.core.startThread({ commandId: randomUUID() });
  const { runId } = await host.core.startRun({
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Use the recorded form tool.',
    threadId,
  });
  await Promise.race([ready.promise, cancelled.promise]);
  lifetime.signal.throwIfAborted();
  send({
    input: { interactionId: id, runId, threadId },
    presentation,
    record: host.record,
    type: 'ready',
  });
}
process.on('message', (message) => {
  if (message?.type === 'start' && !starting) {
    starting = start(message).catch(async (cause) => {
      if (lifetime.signal.aborted && cause === lifetime.signal.reason) {
        send({ type: 'startup-cancelled' });
        return;
      }
      send({ message: cause instanceof Error ? cause.message : String(cause), type: 'failed' });
      process.exitCode = 1;
      // Let the parent's cleanup send stop after observing the original failure.
      throw cause;
    });
    starting.catch(() => undefined);
  } else if (message?.type === 'stop') {
    void close().catch((cause) => {
      send({
        message: cause instanceof Error ? cause.message : String(cause),
        type: 'cleanup-failed',
      });
      process.exitCode = 1;
      if (process.connected) {
        process.disconnect();
      }
    });
  }
});
