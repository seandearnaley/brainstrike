// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { validateMcpElicitationResult } from '@brainstrike/agent/mcp-client';
import { attachAgentHost, type HostToolContext, startAgentHost } from '@brainstrike/agent-host';
import { scriptedModel } from '@brainstrike/agent-host/test-fixtures/scripted-model';
import {
  DEFAULT_PERMISSION_POLICIES,
  parseConfiguredMcpServerId,
} from '@brainstrike/assistant-contract';
import { RootLock } from '@brainstrike/state-store';
import { expect, test } from 'vitest';
import { z } from 'zod';
import {
  mainPlatformConnection,
  type PlatformMessagePort,
} from '../agent-host-platform/connection';
import {
  bindNodeMcpPlatformTransport,
  serveMainMcpPlatformTransport,
} from '../agent-host-platform/mcp-platform-transport';

/** Real Node ports carry the existing utility MessageEvent shape. */
class UtilityPort extends EventEmitter implements PlatformMessagePort {
  constructor(private readonly port: MessagePort) {
    super();
    port.on('message', (data: unknown) => this.emit('message', { data }));
    port.on('close', () => this.emit('close'));
  }
  start(): void {
    this.port.start();
  }
  postMessage(message: unknown): void {
    this.port.postMessage(message);
  }
  close(): void {
    this.port.close();
  }
}

test('actual private Main transport joins Core task/request/intent commits and validates exact run/call before native settlement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-mcp-private-'));
  const channel = new MessageChannel();
  const mainPort = new UtilityPort(channel.port1);
  const nodePort = new UtilityPort(channel.port2);
  const mainConnection = mainPlatformConnection(mainPort);
  const nodeConnection = mainPlatformConnection(nodePort);
  const contexts = new Map<string, HostToolContext & { readonly toolId: string }>();
  const tails = new Set<Promise<unknown>>();
  const main = serveMainMcpPlatformTransport(mainConnection, (work) => {
    tails.add(work);
    const done = (): void => {
      tails.delete(work);
    };
    work.then(done, done);
  });
  const node = bindNodeMcpPlatformTransport(nodeConnection, (origin) => {
    const context = contexts.get(JSON.stringify([origin.runId, origin.toolCallId]));
    return context?.threadId === origin.threadId && context.toolId === origin.toolId
      ? context
      : undefined;
  });
  mainConnection.listen();
  nodeConnection.listen();
  const serverId = parseConfiguredMcpServerId('recorded.private.server');
  const ready = Promise.withResolvers<void>();
  const result = Promise.withResolvers<unknown>();
  result.promise.catch(() => undefined);
  const id = randomUUID();
  const sentinel = `synthetic-private-${randomUUID()}`;
  const request = {
    method: 'elicitation/create',
    params: {
      message: sentinel,
      mode: 'form',
      requestedSchema: {
        properties: { workspace: { type: 'string' } },
        required: ['workspace'],
        type: 'object',
      },
    },
  } satisfies Parameters<typeof validateMcpElicitationResult>[0];
  const handle = {
    authorityEpoch: randomUUID(),
    principalId: 'none',
    resource: 'http://127.0.0.1:1/mcp',
    serverId,
    taskId: 'recorded-private-task',
  };
  const delivered: unknown[] = [];
  let address: { runId: string; threadId: string; toolCallId: string; toolId: string } | undefined;
  const model = scriptedModel('mcp_fixture');
  const host = await startAgentHost(
    { lifetime: 'persistent', root },
    {
      close: async () => undefined,
      maxSteps: 3,
      readPermissionPolicy: () => ({
        policies: { ...DEFAULT_PERMISSION_POLICIES, mcp: 'allow' },
        yolo: true,
      }),
      resolveModel: async () => model,
      tools: {
        mcp_fixture: {
          description: 'Recorded native Main callback',
          execute: async (_input, context) => {
            const origin = {
              runId: context.runId,
              threadId: context.threadId,
              toolCallId: context.toolCallId,
              toolId: 'mcp_fixture',
            };
            address = origin;
            const key = JSON.stringify([origin.runId, origin.toolCallId]);
            contexts.set(key, { ...context, toolId: origin.toolId });
            const abort = (): void => result.reject(new Error('Native private caller aborted'));
            context.signal.addEventListener('abort', abort, { once: true });
            try {
              const callbacks = main.execution(origin, context.signal);
              const assertCurrent = async (): Promise<void> => {
                context.signal.throwIfAborted();
              };
              await callbacks.bindTask({ assertCurrent, handle });
              await callbacks.requestInput({
                assertCurrent,
                presentation: {
                  id,
                  message: sentinel,
                  mode: 'form',
                  provenance: {
                    configuredProtocol: '2026-07-28',
                    configuredServerId: serverId,
                    generation: 7,
                    invocationId: 'recorded-private-invocation',
                    negotiatedRevision: '2026-07-28',
                    operation: { type: 'tools/call' },
                    requestId: 'recorded-private-request',
                    taskHandle: handle,
                    transport: 'streamable-http',
                  },
                  requestedSchema: request.params.requestedSchema,
                },
                settle: async (answer) => {
                  delivered.push(structuredClone(answer));
                  result.resolve({ accepted: true });
                  return 'local-finalized';
                },
                signal: context.signal,
                validate: async (answer) => validateMcpElicitationResult(request, answer),
              });
              ready.resolve();
              return await result.promise;
            } finally {
              context.signal.removeEventListener('abort', abort);
              main.release(origin);
              node.release(origin);
              contexts.delete(key);
            }
          },
          identity: 'private-native-7',
          inputSchema: z.object({ text: z.string() }),
          mcpAuthority: {
            auth: { type: 'none' },
            destination: handle.resource,
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
    }
  );
  const client = await attachAgentHost(host.record);
  try {
    const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
    const { runId } = await client.request('run/start', {
      commandId: randomUUID(),
      modelId: 'scripted',
      prompt: 'Use the recorded native tool.',
      threadId,
    });
    await ready.promise;
    const input = { interactionId: id, runId, threadId };
    const rows = await host.core.read(threadId, 0);
    expect(rows.filter((row) => row.event.type === 'mcp.task.bound')).toHaveLength(1);
    expect(rows.filter((row) => row.event.type === 'mcp.input.requested')).toHaveLength(1);
    expect(JSON.stringify(rows).includes(sentinel)).toBe(false);
    expect((await client.request('mcp/input/read', input)).presentation).toBeDefined();
    await expect(
      nodeConnection.sendRequest('platform/mcp/input/current', {
        id,
        origin: { ...address, runId: randomUUID() },
      })
    ).rejects.toThrow();
    await expect(
      nodeConnection.sendRequest('platform/mcp/input/validate', {
        answer: {
          action: 'accept',
          configuredServerId: serverId,
          content: { [sentinel]: sentinel },
          generation: 7,
          id,
          requestId: 'recorded-private-request',
        },
        id,
        origin: address,
      })
    ).rejects.toSatisfy((error: unknown) => !JSON.stringify(error).includes(sentinel));
    expect(delivered).toHaveLength(0);
    await client.request('mcp/input/stage', { ...input, content: { workspace: sentinel } });
    await client.request('mcp/input/settle', {
      ...input,
      action: 'accept',
      commandId: randomUUID(),
    });
    await expect
      .poll(async () => (await client.request('mcp/input/read', input)).status)
      .toBe('local-finalized');
    await expect
      .poll(async () =>
        (await host.core.read(threadId, 0)).some((row) => row.event.type === 'run.finished')
      )
      .toBe(true);
    expect(delivered).toHaveLength(1);
    expect(model.doStreamCalls).toHaveLength(2);
    expect(JSON.stringify(await host.core.read(threadId, 0)).includes(sentinel)).toBe(false);
    await expect(
      mainConnection.sendRequest('platform/mcp/input/retire', { id, origin: address })
    ).rejects.toThrow();
  } finally {
    await client.close();
    await host.close();
    await Promise.allSettled([...tails]);
    main.close();
    node.close();
    mainConnection.dispose();
    nodeConnection.dispose();
    mainPort.close();
    nodePort.close();
    const lock = await RootLock.acquire(root);
    await lock.release();
    await rm(root, { force: true, recursive: true });
  }
});
