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
import { createProviderFetchTransport } from '../agent-host-platform/provider-fetch-transport';
import { createDesktopMcpPlatformCapabilities } from '../mcp/desktop-host-platform';
import { RemoteMcpRuntime } from '../mcp/remote-runtime';

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
  resolveProviderAuth: DesktopPlatformCapabilities['resolveProviderAuth'] = async () => undefined,
  closeRootCapabilities?: DesktopPlatformCapabilities['closeRootCapabilities']
) {
  const channel = new MessageChannel();
  const first = new UtilityPort(channel.port1);
  const second = new UtilityPort(channel.port2);
  const server = mainPlatformConnection(first);
  const client = mainPlatformConnection(second);
  const owner = serveDesktopPlatform(server, {
    mcp: createDesktopMcpPlatformCapabilities(new RemoteMcpRuntime()),
    ...(closeRootCapabilities ? { closeRootCapabilities } : {}),
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

it.each([false, true])(
  'private close joins Main Root borrowers and retains their failure (failure=%s)',
  async (failed) => {
    const entered = Promise.withResolvers<void>();
    const retired = Promise.withResolvers<void>();
    const failure = new Error('Main native owner retirement failed');
    const closeRoot = vi.fn(async (): Promise<void> => {
      entered.resolve();
      await retired.promise;
      if (failed) {
        throw failure;
      }
    });
    const f = harness(
      async () => selected({}),
      async () => undefined,
      closeRoot
    );
    try {
      let acknowledged = false;
      const closing = f.client.sendRequest('platform/close', {}).then(() => {
        acknowledged = true;
      });
      const outcome = Promise.allSettled([closing]);
      await entered.promise;
      expect(acknowledged).toBe(false);
      retired.resolve();
      const [result] = await outcome;
      if (failed) {
        expect(result?.status).toBe('rejected');
        await expect(f.owner.close()).rejects.toMatchObject({ errors: [failure] });
      } else {
        expect(result?.status).toBe('fulfilled');
        await f.owner.close();
      }
      expect(closeRoot).toHaveBeenCalledOnce();
    } finally {
      retired.resolve();
      f.destroy();
    }
  }
);

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
    async () => ({ ...selected({}), configuration: { model: 'fixture', provider: 'bedrock' } }),
    async () => ({
      credentialProvider: resolve,
      kind: 'aws',
      region: 'us-east-1',
    })
  );
  try {
    await admit(h.client);
    const auth = decodePlatformAuth(
      await h.client.sendRequest('platform/auth', { provider: 'bedrock', threadId: 'thread' })
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

it.each([false, true])(
  'Main joins the admitted provider body before Root cleanup and retains its failure (failure=%s)',
  async (failed) => {
    const cancelling = Promise.withResolvers<void>();
    const physical = Promise.withResolvers<void>();
    const originalFailure = new Error('Captured subscription body failed to retire');
    const closeSelection = vi.fn(async () => undefined);
    const closeRoot = vi.fn(async () => undefined);
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel: async () => {
              cancelling.resolve();
              await physical.promise;
              if (failed) {
                throw originalFailure;
              }
            },
          })
        )
    );
    const auth = vi.fn(async () => ({
      apiKey: 'fixture-dummy',
      fetch,
      kind: 'custom_fetch' as const,
    }));
    const h = harness(async () => selected({}, closeSelection), auth, closeRoot);
    const proxy = createProviderFetchTransport(h.client, {
      provider: 'openai',
      threadId: 'thread',
    });
    try {
      await expect(
        h.client.sendRequest('platform/auth', { provider: 'openai', threadId: 'thread' })
      ).rejects.toThrow();
      expect(auth).not.toHaveBeenCalled();
      await admit(h.client);
      await expect(
        h.client.sendRequest('platform/auth', { provider: 'google', threadId: 'thread' })
      ).rejects.toThrow();
      expect(auth).not.toHaveBeenCalled();
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(
          h.client.sendRequest('platform/auth', { provider: 'openai', threadId: 'thread' })
        ).resolves.toEqual({ kind: 'custom_fetch' });
      }
      expect(auth).toHaveBeenCalledOnce();
      await proxy.fetch('https://synthetic.invalid/response');
      let acknowledged = false;
      const closing = h.client.sendRequest('platform/close', {}).then(() => {
        acknowledged = true;
      });
      const outcome = Promise.allSettled([closing]);
      await cancelling.promise;
      expect(acknowledged).toBe(false);
      expect(closeSelection).not.toHaveBeenCalled();
      expect(closeRoot).not.toHaveBeenCalled();
      physical.resolve();
      const [result] = await outcome;
      // The requester joins its transport while cancellation RPCs are still
      // writable; the enclosing owner close disposes the server connection.
      const [clientJoin] = await Promise.allSettled([proxy.close()]);
      if (failed) {
        expect(result?.status).toBe('rejected');
        expect(clientJoin?.status).toBe('rejected');
        const [ownerJoin] = await Promise.allSettled([h.owner.close()]);
        if (ownerJoin?.status !== 'rejected') {
          throw new Error('Main owner close lost its original provider failure');
        }
        const causes: unknown[] = [ownerJoin.reason];
        for (const cause of causes) {
          if (cause instanceof AggregateError) {
            causes.push(...cause.errors);
          }
        }
        expect(causes).toContain(originalFailure);
      } else {
        expect(result?.status).toBe('fulfilled');
        expect(clientJoin?.status).toBe('fulfilled');
        await h.owner.close();
      }
      expect(closeSelection).toHaveBeenCalledOnce();
      expect(closeRoot).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      physical.resolve();
      await Promise.allSettled([proxy.close()]);
      await Promise.allSettled([h.owner.close()]);
      h.destroy();
    }
  }
);

it('selection release joins the original auth lookup after its requester cancels', async () => {
  const entered = Promise.withResolvers<void>();
  const original = Promise.withResolvers<undefined>();
  const borrowedClose = vi.fn(async () => undefined);
  const h = harness(
    async () => selected({}, borrowedClose),
    async () => {
      entered.resolve();
      return await original.promise;
    }
  );
  const cancellation = new CancellationTokenSource();
  try {
    await admit(h.client);
    const auth = Promise.allSettled([
      h.client.sendRequest(
        'platform/auth',
        { provider: 'openai', threadId: 'thread' },
        cancellation.token
      ),
    ]);
    await entered.promise;
    cancellation.cancel();
    let acknowledged = false;
    const release = h.client.sendRequest('platform/release', { threadId: 'thread' }).then(() => {
      acknowledged = true;
    });
    const joined = Promise.allSettled([release]);
    // A later independent RPC demonstrates the peer has dispatched requests.
    await h.client.sendRequest('platform/policy', { threadId: 'thread' });
    expect(acknowledged).toBe(false);
    expect(borrowedClose).not.toHaveBeenCalled();
    original.resolve(undefined);
    const [result] = await joined;
    expect(result?.status).toBe('fulfilled');
    await auth;
    expect(borrowedClose).toHaveBeenCalledOnce();
  } finally {
    original.resolve(undefined);
    cancellation.dispose();
    await h.owner.close();
    h.destroy();
  }
});

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
