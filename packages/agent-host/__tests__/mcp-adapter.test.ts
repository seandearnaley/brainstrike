import {
  createMcpAppToolInvocationResult,
  createMcpTaskToolInvocationResult,
  MCP_APPS_MIME_TYPE,
  type McpHostPort,
  type McpHostWatchEvent,
  type McpHostWatchFilter,
  parseConfiguredMcpServerId,
} from '@brainstrike/assistant-contract';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import { z } from 'zod';
import {
  createMcpHostToolAdapter,
  type McpHostToolAdapter,
  type McpHostToolBinding,
  McpHostToolRetiredError,
} from '../src/adapters/mcp.js';
import type { HostTool, HostToolContext } from '../src/ports.js';

// Result shapes from the shipped mixed-media stdio and task-tool fixtures.
// These are adapter boundary tests, not MCP transport or product qualification.
const richResult = {
  content: [
    { text: 'mcp-stdio-multimodal-raw-only-tail', type: 'text' },
    { data: 'aW1hZ2UtYnl0ZXM=', mimeType: 'image/png', type: 'image' },
    { data: 'YXVkaW8tYnl0ZXM=', mimeType: 'audio/wav', type: 'audio' },
  ],
  structuredContent: { mediaCount: 2, provenance: 'mixed-structured-stdio-media-fixture' },
} as const;
const createdTaskResult = {
  createdAt: '2026-09-01T05:00:00.000Z',
  lastUpdatedAt: '2026-09-01T05:00:00.000Z',
  resultType: 'task',
  status: 'working',
  taskId: 'task-a',
  ttlMs: null,
};
const taskResult = createMcpTaskToolInvocationResult({
  canCancel: true,
  createdAt: '2026-09-01T05:00:00.000Z',
  handle: {
    authorityEpoch: '00000000-0000-7000-8000-000000000000',
    principalId: 'principal-a',
    resource: 'https://tasks.example.test',
    serverId: 'remote',
    taskId: 'task-a',
  },
  history: [{ at: '2026-09-01T05:00:00.000Z', status: 'working' }],
  omittedHistoryEntries: 0,
  recovery: 'live',
  status: 'working',
  statusMessage: 'Preparing export',
  updatedAt: '2026-09-01T05:00:01.000Z',
});
const appResult = createMcpAppToolInvocationResult(
  {
    mimeType: MCP_APPS_MIME_TYPE,
    resourceUri: 'ui://remote/export',
    serverId: 'remote',
    toolName: 'export',
  },
  taskResult
);

interface Subscription {
  readonly filter: McpHostWatchFilter;
  readonly listener: (event: McpHostWatchEvent) => void;
}

function authority(names: readonly string[] = ['server.with.dots']) {
  const generations = new Map(names.map((name) => [parseConfiguredMcpServerId(name), 1]));
  const subscriptions = new Set<Subscription>();
  const releases: Mock<() => void>[] = [];
  let revision = 1;
  const snapshot = () => ({
    revision,
    servers: [...generations].map(([configuredServerId, generation]) => ({
      configuredProtocol: 'legacy' as const,
      configuredServerId,
      generation,
      state: 'disconnected' as const,
      transport: 'stdio' as const,
    })),
  });
  const host = {
    close: vi.fn(async () => ({
      callbacksClosed: 0,
      childProcessesClosed: 0,
      clientsClosed: 0,
      failures: [],
      loopbackPortsClosed: 0,
      probesClosed: 0,
      requestsSettled: 0,
      subscriptionsClosed: 0,
    })),
    control: vi.fn(async () => {
      throw new Error('Adapter must not control the shared host');
    }),
    invoke: vi.fn<McpHostPort['invoke']>(async () => ({
      result: richResult,
      type: 'tools/call',
    })),
    replaceConfig: vi.fn(async () => {
      throw new Error('Adapter must not replace shared configuration');
    }),
    snapshot: vi.fn(snapshot),
    watch: vi.fn<McpHostPort['watch']>((filter, listener) => {
      const subscription = { filter, listener };
      subscriptions.add(subscription);
      const release = vi.fn((): void => {
        subscriptions.delete(subscription);
      });
      releases.push(release);
      return release;
    }),
  } satisfies McpHostPort;
  return {
    generations,
    host,
    publish(): void {
      revision += 1;
      const event = snapshot();
      for (const subscription of subscriptions) {
        subscription.listener(event);
      }
    },
    releases,
    subscriptions,
  };
}

function binding(
  overrides: Partial<HostTool> = {},
  serverId = 'server.with.dots'
): McpHostToolBinding {
  return {
    configuredServerId: parseConfiguredMcpServerId(serverId),
    generation: 1,
    tool: {
      description: 'Existing MCP executor',
      execute: vi.fn(async () => richResult),
      identity: 'existing-executor-generation-1',
      inputSchema: z.object({}),
      risk: 'mcp',
      ...overrides,
    },
  };
}

function context(signal = new AbortController().signal): HostToolContext {
  return { runId: 'run-a', signal, threadId: 'thread-a', toolCallId: 'call-a' };
}

const adapters: McpHostToolAdapter[] = [];
function wrap(host: McpHostPort, bindings: Readonly<Record<string, McpHostToolBinding>>) {
  const adapter = createMcpHostToolAdapter({ bindings, host });
  adapters.push(adapter);
  return adapter;
}
function tool(adapter: McpHostToolAdapter, id = 'model_alias'): HostTool {
  const value = adapter.tools[id];
  if (!value) {
    throw new Error('Missing fixture tool');
  }
  return value;
}
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
});

describe('borrowed Node MCP host tool bindings', () => {
  it('retains tool-owned reconstruction and joins it before releasing authority watches', async () => {
    const source = authority();
    const entered = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<unknown>();
    const reconstructed = new Date('2026-10-06T07:00:00.000Z');
    let hold = false;
    let receiver: HostTool | undefined;
    const admitted = binding({
      async reconstructApprovalInput(this: HostTool): Promise<unknown> {
        receiver = this;
        if (hold) {
          entered.resolve();
          return await pending.promise;
        }
        return reconstructed;
      },
    });
    const adapter = wrap(source.host, { model_alias: admitted });
    const reconstruct = tool(adapter).reconstructApprovalInput;
    expect(reconstruct).toBeTypeOf('function');
    if (!reconstruct) {
      throw new Error('Authority reconstruction capability was discarded');
    }
    expect(await reconstruct({ at: reconstructed.toISOString() })).toBe(reconstructed);
    expect(receiver).toBe(admitted.tool);
    hold = true;
    const observed = reconstruct({ at: reconstructed.toISOString() }).catch(
      (cause: unknown) => cause
    );
    await entered.promise;
    const closing = adapter.close();
    expect(source.releases[0]).not.toHaveBeenCalled();
    pending.resolve(reconstructed);
    expect(await observed).toMatchObject({ message: 'MCP host tool adapter is closed' });
    await closing;
    expect(source.releases[0]).toHaveBeenCalledOnce();
    expect(admitted.tool.execute).not.toHaveBeenCalled();
  });

  it.each([
    ['mixed media', richResult],
    [
      'structured-only envelope',
      {
        content: [{ text: 'duplicate', type: 'text' }],
        structuredContent: { value: 'structured-stdio-only' },
      },
    ],
    ['Tasks presentation', taskResult],
    ['authority-tracked raw task', createdTaskResult],
    ['Apps with a Tasks presentation', appResult],
    [
      'registered extension result',
      {
        content: [],
        'io.brainstrike/registeredExtensionResult': createdTaskResult,
        resultType: 'complete',
      },
    ],
  ])("preserves the authority executor's complete %s result", async (_name, output) => {
    const source = authority(['remote']);
    const admitted = binding({ execute: vi.fn(async () => output) });
    const adapter = wrap(source.host, {
      model_alias: { ...admitted, configuredServerId: parseConfiguredMcpServerId('remote') },
    });
    expect(await tool(adapter).execute({}, context())).toBe(output);
    expect(source.host.invoke).not.toHaveBeenCalled();
  });

  it('retains exact schema, executor identity, receiver and canonical routing', async () => {
    const source = authority();
    const inputSchema = z.object({ query: z.string().optional() }).passthrough();
    let receiver: HostTool | undefined;
    let execution: HostToolContext | undefined;
    const admitted = binding({
      async execute(this: HostTool, input, supplied) {
        receiver = this;
        execution = supplied;
        const result = await source.host.invoke(
          {
            arguments: { query: 'owned input' },
            configuredServerId: parseConfiguredMcpServerId('server.with.dots'),
            toolName: 'tool.with.dots',
            type: 'tools/call',
          },
          { signal: supplied.signal }
        );
        expect(input).toBe(args);
        return result.result;
      },
      inputSchema,
    });
    const args = { extensionField: 'preserved', query: 'owned input' };
    const adapter = wrap(source.host, { model_alias: admitted });
    expect(tool(adapter).identity).toBe(admitted.tool.identity);
    expect(tool(adapter).inputSchema).toBe(inputSchema);
    expect(tool(adapter).risk).toBe('mcp');
    expect(await tool(adapter).execute(args, context())).toBe(richResult);
    expect(receiver).toBe(admitted.tool);
    expect(execution).toMatchObject({ runId: 'run-a', threadId: 'thread-a', toolCallId: 'call-a' });
    expect(source.host.invoke).toHaveBeenCalledOnce();
    expect(source.host.invoke.mock.calls[0]?.[0]).toMatchObject({
      configuredServerId: 'server.with.dots',
      toolName: 'tool.with.dots',
    });
    expect(source.host.watch).toHaveBeenCalledWith(
      { configuredServerIds: ['server.with.dots'] },
      expect.any(Function)
    );
    await adapter.close();
    expect(source.subscriptions.size).toBe(0);
    expect(source.host.close).not.toHaveBeenCalled();
    expect(source.host.control).not.toHaveBeenCalled();
    expect(source.host.replaceConfig).not.toHaveBeenCalled();
  });

  it('shares one watch for a server without changing its two executor identities', () => {
    const source = authority();
    const adapter = wrap(source.host, {
      first: binding({ identity: 'executor-a' }),
      second: binding({ identity: 'executor-b' }),
    });
    expect(source.host.watch).toHaveBeenCalledOnce();
    expect(tool(adapter, 'first').identity).toBe('executor-a');
    expect(tool(adapter, 'second').identity).toBe('executor-b');
    expect(Object.isFrozen(adapter.tools)).toBe(true);
  });

  it('refuses mixed generations before acquiring any watches', () => {
    const source = authority();
    expect(() =>
      createMcpHostToolAdapter({
        bindings: { first: binding(), second: { ...binding(), generation: 2 } },
        host: source.host,
      })
    ).toThrow('mix generations');
    expect(source.host.watch).not.toHaveBeenCalled();
  });

  it('releases acquired watches when construction observes a retired generation', () => {
    const source = authority();
    source.generations.set(parseConfiguredMcpServerId('server.with.dots'), 2);
    expect(() =>
      createMcpHostToolAdapter({ bindings: { model_alias: binding() }, host: source.host })
    ).toThrow(McpHostToolRetiredError);
    expect(source.subscriptions.size).toBe(0);
    expect(source.releases[0]).toHaveBeenCalledOnce();
  });

  it('preserves acquisition and cleanup failures without leaking earlier ownership', () => {
    const source = authority(['first', 'second']);
    const construction = new Error('second watch failed');
    const cleanup = new Error('first watch release failed');
    const release = vi.fn(() => {
      throw cleanup;
    });
    source.host.watch.mockReturnValueOnce(release).mockImplementationOnce(() => {
      throw construction;
    });
    let cause: unknown;
    try {
      createMcpHostToolAdapter({
        bindings: { first: binding({}, 'first'), second: binding({}, 'second') },
        host: source.host,
      });
    } catch (error) {
      cause = error;
    }
    expect(cause).toBeInstanceOf(AggregateError);
    expect(cause instanceof AggregateError ? cause.errors : []).toEqual([construction, cleanup]);
    expect(release).toHaveBeenCalledOnce();
    expect(source.host.close).not.toHaveBeenCalled();
  });

  it('releases watches when executable metadata cannot be read', () => {
    const source = authority();
    const cause = new Error('executor metadata failed');
    const admitted = binding();
    Object.defineProperty(admitted.tool, 'description', {
      get: () => {
        throw cause;
      },
    });
    expect(() =>
      createMcpHostToolAdapter({ bindings: { model_alias: admitted }, host: source.host })
    ).toThrow(cause);
    expect(source.subscriptions.size).toBe(0);
  });

  it.each(['replace', 'remove'])(
    'refuses a %s generation even before a watch notification',
    async (change) => {
      const source = authority();
      const execute = vi.fn(async () => richResult);
      const adapter = wrap(source.host, { model_alias: binding({ execute }) });
      const id = parseConfiguredMcpServerId('server.with.dots');
      if (change === 'replace') {
        source.generations.set(id, 2);
      } else {
        source.generations.delete(id);
      }
      await expect(tool(adapter).execute({}, context())).rejects.toBeInstanceOf(
        McpHostToolRetiredError
      );
      expect(execute).not.toHaveBeenCalled();
    }
  );

  it.each(['identity', 'executor'])(
    'refuses a changed %s on the original binding',
    async (change) => {
      const source = authority();
      const execute = vi.fn(async () => richResult);
      const admitted = binding({ execute });
      const adapter = wrap(source.host, { model_alias: admitted });
      if (change === 'identity') {
        Object.defineProperty(admitted.tool, 'identity', { value: 'replacement-identity' });
      } else {
        admitted.tool.execute = vi.fn(async () => taskResult);
      }
      await expect(tool(adapter).execute({}, context())).rejects.toBeInstanceOf(
        McpHostToolRetiredError
      );
      expect(execute).not.toHaveBeenCalled();
      expect(tool(adapter).identity).toBe('existing-executor-generation-1');
    }
  );

  it('forwards prior cancellation without invoking the executor', async () => {
    const source = authority();
    const execute = vi.fn(async () => richResult);
    const adapter = wrap(source.host, { model_alias: binding({ execute }) });
    const reason = new Error('caller cancelled');
    await expect(tool(adapter).execute({}, context(AbortSignal.abort(reason)))).rejects.toBe(
      reason
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('cancels in-flight work on generation retirement and joins the executor cleanup', async () => {
    const source = authority();
    const started = Promise.withResolvers<HostToolContext>();
    const cleanup = Promise.withResolvers<void>();
    const adapter = wrap(source.host, {
      model_alias: binding({
        execute: async (_input, supplied) => {
          started.resolve(supplied);
          await cleanup.promise;
          supplied.signal.throwIfAborted();
          return richResult;
        },
      }),
    });
    const call = tool(adapter)
      .execute({}, context())
      .catch((cause: unknown) => cause);
    const executing = await started.promise;
    source.generations.set(parseConfiguredMcpServerId('server.with.dots'), 2);
    source.publish();
    expect(executing.signal.aborted).toBe(true);
    const closing = adapter.close();
    expect(closing).toBe(adapter.close());
    expect(source.releases[0]).not.toHaveBeenCalled();
    cleanup.resolve();
    expect(await call).toBeInstanceOf(McpHostToolRetiredError);
    await closing;
    expect(source.releases[0]).toHaveBeenCalledOnce();
  });

  it('joins an executor that settles late after caller cancellation', async () => {
    const source = authority();
    const started = Promise.withResolvers<HostToolContext>();
    const finish = Promise.withResolvers<unknown>();
    const caller = new AbortController();
    const adapter = wrap(source.host, {
      model_alias: binding({
        execute: async (_input, supplied) => {
          started.resolve(supplied);
          return await finish.promise;
        },
      }),
    });
    const call = tool(adapter)
      .execute({}, context(caller.signal))
      .catch((cause: unknown) => cause);
    const executing = await started.promise;
    const reason = new Error('caller cancelled');
    caller.abort(reason);
    expect(executing.signal.reason).toBe(reason);
    let closed = false;
    const closing = adapter.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    finish.resolve(richResult);
    expect(await call).toBe(reason);
    await closing;
  });

  it('fences a queued execution before its first side effect during close', async () => {
    const source = authority();
    const execute = vi.fn(async () => richResult);
    const adapter = wrap(source.host, { model_alias: binding({ execute }) });
    const call = tool(adapter)
      .execute({}, context())
      .catch((cause: unknown) => cause);
    await adapter.close();
    expect(await call).toBeInstanceOf(Error);
    expect(execute).not.toHaveBeenCalled();
    await expect(tool(adapter).execute({}, context())).rejects.toThrow('adapter is closed');
  });

  it('preserves executor failure identity', async () => {
    const source = authority();
    const reason = new Error('existing MCP executor failure');
    const adapter = wrap(source.host, {
      model_alias: binding({
        execute: async () => {
          throw reason;
        },
      }),
    });
    await expect(tool(adapter).execute({}, context())).rejects.toBe(reason);
  });

  it('retains failed watch cleanup across repeated close without closing the authority', async () => {
    const source = authority();
    const reason = new Error('watch cleanup failed');
    const release = vi.fn(() => {
      throw reason;
    });
    source.host.watch.mockReturnValueOnce(release);
    const adapter = createMcpHostToolAdapter({
      bindings: { model_alias: binding() },
      host: source.host,
    });
    const closing = adapter.close();
    await expect(closing).rejects.toBe(reason);
    expect(adapter.close()).toBe(closing);
    await expect(adapter.close()).rejects.toBe(reason);
    expect(release).toHaveBeenCalledOnce();
    expect(source.host.close).not.toHaveBeenCalled();
  });
});
