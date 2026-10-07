// @vitest-environment node
import { EventEmitter } from 'node:events';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import {
  canonicalToolInputSchema,
  type HostTool,
  platformToolInputSchema,
  validateCanonicalToolInput,
} from '@brainstrike/agent-host';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { expect, it, vi } from 'vitest';
import { CancellationTokenSource, type MessageConnection } from 'vscode-jsonrpc/node';
import { z } from 'zod';
import {
  mainPlatformConnection,
  type PlatformMessagePort,
} from '../agent-host-platform/connection';
import {
  type DesktopPlatformCapabilities,
  type DesktopPlatformSelection,
  serveDesktopPlatform,
} from '../agent-host-platform/main-platform';
import { decodePlatformAuth } from '../agent-host-platform/platform-auth';

/** Real Node ports with the Electron utility port's public MessageEvent shape. */
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
function selected(
  tools: Readonly<Record<string, HostTool>>,
  close = vi.fn(async () => undefined)
): DesktopPlatformSelection {
  return {
    close,
    configuration: { model: 'fixture', provider: 'openai' },
    contextWindow: 32_000,
    durableConfiguration: {},
    inputTokenLimit: 24_000,
    maxSteps: 5,
    memory: {
      options: {
        lastMessages: 12,
        workingMemory: { enabled: false, scope: 'thread', template: '' },
      },
      settings: {
        observationalMemory: {
          enabled: false,
          messageTokens: 30_000,
          modelTarget: 'auto',
          observationTokens: 40_000,
          retrievalMode: 'off',
          scope: 'thread',
        },
        semanticRecall: {
          embeddingModelTarget: null,
          enabled: false,
          messageRange: 2,
          scope: 'resource',
          topK: 5,
        },
      },
    },
    resourceId: 'workspace',
    tools,
    toolTimeoutMs: 5000,
  };
}
function harness(
  readConfiguration: DesktopPlatformCapabilities['readConfiguration'],
  resolveProviderAuth: DesktopPlatformCapabilities['resolveProviderAuth'] = async () => undefined
) {
  const channel = new MessageChannel();
  const first = new UtilityPort(channel.port1);
  const second = new UtilityPort(channel.port2);
  const server = mainPlatformConnection(first);
  const client = mainPlatformConnection(second);
  const owner = serveDesktopPlatform(server, {
    readConfiguration,
    readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
    resolveProviderAuth,
  });
  client.onClose(() => client.dispose());
  client.listen();
  return {
    client,
    crash: () => second.close(),
    destroy: () => {
      client.dispose();
      server.dispose();
      first.close();
      second.close();
    },
    owner,
    server,
  };
}

it('retains the resolved AWS chain across the private port once without a bearer fallback', async () => {
  const identity = {
    accessKeyId: 'AKIDEXAMPLE',
    accountId: '123456789012',
    expiration: new Date('2030-01-01T00:00:00.000Z'),
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    sessionToken: 'owned-fixture-session',
  };
  const resolve = vi.fn(async () => identity);
  const h = harness(
    async () => selected({}),
    async () => ({
      credentialProvider: resolve,
      kind: 'aws',
      region: 'us-east-1',
    })
  );
  try {
    const auth = decodePlatformAuth(
      await h.client.sendRequest('platform/auth', { provider: 'bedrock' })
    );
    if (auth?.kind !== 'aws' || !auth.credentialProvider) {
      throw new Error('The private port lost the selected chain capability');
    }
    expect(auth.apiKey).toBeUndefined();
    expect(auth.region).toBe('us-east-1');
    expect(await auth.credentialProvider()).toEqual(identity);
    expect(await auth.credentialProvider()).toEqual(identity);
    expect(resolve).toHaveBeenCalledTimes(1);
  } finally {
    h.destroy();
    await h.owner.close();
  }
});
async function admit(client: MessageConnection): Promise<unknown> {
  return client.sendRequest('platform/admit', { modelId: 'openai::fixture', threadId: 'thread' });
}

it('utility loss aborts a progress-blocked executor and joins its physical tail before releasing the selection', async () => {
  const entered = Promise.withResolvers<AbortSignal>();
  const progressEntered = Promise.withResolvers<void>();
  const progressHeld = Promise.withResolvers<void>();
  const physicalTail = Promise.withResolvers<void>();
  const serverClosed = Promise.withResolvers<void>();
  const release = vi.fn(async () => undefined);
  let progressRejected = false;
  const h = harness(async () =>
    selected(
      {
        tool: {
          description: 'fixture',
          execute: async (_input, context) => {
            entered.resolve(context.signal);
            try {
              await context.write?.({ pending: true });
            } catch (cause) {
              progressRejected = true;
              throw cause;
            } finally {
              await physicalTail.promise;
            }
            return {};
          },
          identity: 'canonical',
          inputSchema: z.object({}),
          risk: 'execute',
        },
      },
      release
    )
  );
  h.server.onClose(() => serverClosed.resolve());
  h.client.onRequest('platform/progress', async () => {
    progressEntered.resolve();
    await progressHeld.promise;
  });
  try {
    await admit(h.client);
    const executing = h.client.sendRequest('platform/execute', {
      input: {},
      runId: 'run',
      threadId: 'thread',
      toolCallId: 'call',
      toolId: 'tool',
    });
    executing.catch(() => undefined);
    const signal = await entered.promise;
    await progressEntered.promise;
    h.crash();
    await serverClosed.promise;
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
    await vi.waitFor(() => expect(progressRejected).toBe(true));
    let closed = false;
    const closing = h.owner.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(release).not.toHaveBeenCalled();
    physicalTail.resolve();
    await closing;
    await expect(executing).rejects.toThrow();
    expect(release).toHaveBeenCalledTimes(1);
  } finally {
    physicalTail.resolve();
    progressHeld.resolve();
    h.destroy();
    await h.owner.close();
  }
});

it('preserves canonical transforms, validator failures, progress acknowledgement and model projection over real ports', async () => {
  const inputSchema = canonicalToolInputSchema(
    z.object({
      count: z
        .number()
        .int()
        .positive()
        .transform((value) => value + 1),
    })
  );
  const executed: unknown[] = [];
  const progress: unknown[] = [];
  const projected: unknown[] = [];
  const close = vi.fn(async () => undefined);
  const h = harness(async () =>
    selected(
      {
        tool: {
          description: 'fixture',
          execute: async (input, context) => {
            executed.push(input);
            await context.write?.({ count: 1 });
            expect(progress).toEqual([{ count: 1 }]);
            return { completed: true };
          },
          identity: 'canonical',
          inputSchema,
          permissionToolId: 'canonical-tool',
          risk: 'edit',
          toModelOutput: ({ input, output }) => {
            projected.push(input);
            return { type: 'json', value: z.json().parse(output) };
          },
        },
      },
      close
    )
  );
  h.client.onRequest('platform/progress', (input: unknown) => {
    progress.push(z.object({ chunk: z.json() }).parse(input).chunk);
  });
  try {
    const catalog = z
      .object({
        tools: z.record(z.string(), z.object({ inputSchema: z.record(z.string(), z.json()) })),
      })
      .parse(await admit(h.client));
    const descriptor = catalog.tools['tool'];
    if (!descriptor) {
      throw new Error('Missing fixture tool');
    }
    const schema = platformToolInputSchema(descriptor.inputSchema, async (input) =>
      z
        .discriminatedUnion('success', [
          z.object({ success: z.literal(true), value: z.json() }),
          z.object({ error: z.string(), success: z.literal(false) }),
        ])
        .parse(
          await h.client.sendRequest('platform/validate', {
            input,
            threadId: 'thread',
            toolId: 'tool',
          })
        )
    );
    expect(await validateCanonicalToolInput(schema, { count: 2 })).toEqual({
      success: true,
      value: { count: 3 },
    });
    expect((await validateCanonicalToolInput(schema, { count: 0 })).success).toBe(false);
    expect(executed).toEqual([]);
    const output = await h.client.sendRequest('platform/execute', {
      input: { count: 3 },
      runId: 'run',
      threadId: 'thread',
      toolCallId: 'call',
      toolId: 'tool',
    });
    expect(executed).toEqual([{ count: 3 }]);
    await h.client.sendRequest('platform/project', {
      input: { count: 3 },
      output,
      threadId: 'thread',
      toolCallId: 'call',
      toolId: 'tool',
    });
    expect(projected).toEqual([{ count: 3 }]);
    await h.client.sendRequest('platform/release', { threadId: 'thread' });
    await h.owner.close();
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    h.destroy();
  }
});

it('cancellation and close wait for the admitted executor physical tail before releasing borrowed capabilities', async () => {
  const entered = Promise.withResolvers<AbortSignal>();
  const joined = Promise.withResolvers<void>();
  const close = vi.fn(async () => undefined);
  const h = harness(async () =>
    selected(
      {
        tool: {
          description: 'fixture',
          execute: async (_input, context) => {
            entered.resolve(context.signal);
            await joined.promise;
            context.signal.throwIfAborted();
            return {};
          },
          identity: 'canonical',
          inputSchema: z.object({}),
          risk: 'execute',
        },
      },
      close
    )
  );
  const cancellation = new CancellationTokenSource();
  let settled = false;
  try {
    await admit(h.client);
    const executing = h.client.sendRequest(
      'platform/execute',
      { input: {}, runId: 'run', threadId: 'thread', toolCallId: 'call', toolId: 'tool' },
      cancellation.token
    );
    executing.catch(() => undefined);
    const signal = await entered.promise;
    cancellation.cancel();
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
    const closing = h.owner.close().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(close).not.toHaveBeenCalled();
    joined.resolve();
    await expect(executing).rejects.toBeInstanceOf(Error);
    await closing;
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    joined.resolve();
    cancellation.dispose();
    h.destroy();
  }
});

it('an aborted admission joins the arriving selection and retains an independent cleanup failure', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const cleanup = new Error('fixture cleanup failure');
  const close = vi.fn(async () => {
    throw cleanup;
  });
  const h = harness(async () => {
    entered.resolve();
    await release.promise;
    return selected({}, close);
  });
  const cancellation = new CancellationTokenSource();
  try {
    const admitted = h.client.sendRequest(
      'platform/admit',
      { modelId: 'openai::fixture', threadId: 'thread' },
      cancellation.token
    );
    admitted.catch(() => undefined);
    await entered.promise;
    cancellation.cancel();
    const closing = h.owner.close();
    closing.catch(() => undefined);
    expect(close).not.toHaveBeenCalled();
    release.resolve();
    await expect(admitted).rejects.toBeInstanceOf(Error);
    const failure = await closing.catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) {
      throw new Error('Expected retained failure');
    }
    expect(failure.errors).toContain(cleanup);
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    release.resolve();
    cancellation.dispose();
    h.destroy();
  }
});

it('failed schema projection releases the selection before an admission error returns', async () => {
  const close = vi.fn(async () => undefined);
  const h = harness(async () =>
    selected(
      {
        tool: {
          description: 'fixture',
          execute: async () => ({}),
          identity: 'canonical',
          inputSchema: canonicalToolInputSchema(z.object({ value: z.date() })),
          risk: 'read',
        },
      },
      close
    )
  );
  try {
    await expect(admit(h.client)).rejects.toBeInstanceOf(Error);
    expect(close).toHaveBeenCalledTimes(1);
    await h.owner.close();
  } finally {
    h.destroy();
  }
});
