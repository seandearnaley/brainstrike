import {
  MCP_TASKS_CALL_TOOL_REQUEST_CONTRACT,
  McpClientExtensionRegistry,
  registerMcpTasksWireContracts,
} from '@brainstrike/agent/mcp-client';
import type { McpHostOperation } from '@brainstrike/assistant-contract';
import { parseConfiguredMcpServerId } from '@brainstrike/assistant-contract';
import { describe, expect, it, vi } from 'vitest';
import {
  createMcpCoreServerFeatures,
  type McpCoreFeatureClient,
} from '../../mcp/core-server-features';

const serverId = parseConfiguredMcpServerId('fixture');
const TOOLS = { tools: [{ inputSchema: { type: 'object' as const }, name: 'search' }] };
const RESOURCES = {
  cacheScope: 'private',
  resources: [{ name: 'issue', uri: 'linear://issue/BST-1471' }],
  ttlMs: 1000,
};
const TEMPLATES = {
  resourceTemplates: [{ name: 'issue', uriTemplate: 'linear://issue/{identifier}' }],
};
const PROMPTS = { prompts: [{ name: 'summarize' }] };
const NEVER_CLOSE = new Promise<'graceful' | 'local' | 'remote'>(() => undefined);

type OperationWithoutServer<T = McpHostOperation> = T extends McpHostOperation
  ? Omit<T, 'configuredServerId'>
  : never;

function operation(value: OperationWithoutServer): McpHostOperation {
  return { ...value, configuredServerId: serverId } as McpHostOperation;
}

function subscription(
  honoredFilter: Record<string, unknown>,
  reason: Promise<'graceful' | 'local' | 'remote'> = NEVER_CLOSE
) {
  return {
    close: vi.fn(async () => undefined),
    closed: reason,
    honoredFilter,
  };
}

function createClient(era: 'legacy' | 'modern' = 'modern') {
  let handlers: Parameters<McpCoreFeatureClient['watchServerFeatures']>[0] | undefined;
  const firstSubscription = subscription({
    promptsListChanged: true,
    resourcesListChanged: true,
    toolsListChanged: true,
  });
  const client = {
    callTool: vi.fn(async () => ({ content: [{ text: 'called', type: 'text' as const }] })),
    complete: vi.fn(async () => ({ completion: { values: ['formal'] } })),
    getPrompt: vi.fn(async () => ({
      messages: [
        { content: { text: 'Prompt body', type: 'text' as const }, role: 'user' as const },
      ],
    })),
    getProtocolEra: vi.fn(() => era),
    getServerCapabilities: vi.fn(() => ({
      completions: {},
      prompts: { listChanged: true },
      resources: { listChanged: true, subscribe: true },
      tools: { listChanged: true },
    })),
    listen: vi.fn(async () => firstSubscription),
    listPrompts: vi.fn(async () => PROMPTS),
    listResources: vi.fn(async () => RESOURCES),
    listResourceTemplates: vi.fn(async () => TEMPLATES),
    listTools: vi.fn(async () => TOOLS),
    readResource: vi.fn(async () => ({
      contents: [{ text: '# BST-1471', uri: 'linear://issue/BST-1471' }],
    })),
    subscribeResource: vi.fn(async () => undefined),
    unsubscribeResource: vi.fn(async () => undefined),
    watchServerFeatures: vi.fn((next) => {
      handlers = next;
      return vi.fn();
    }),
  } satisfies McpCoreFeatureClient;
  return { client, firstSubscription, handlers: () => handlers };
}

describe('MCP core server features', () => {
  it('builds a complete modern catalog and refreshes only the affected server sections', async () => {
    const fixture = createClient();
    const changed = vi.fn();
    const features = createMcpCoreServerFeatures(fixture.client, {
      onCatalogChanged: changed,
    });

    await features.initialize();

    expect(features.snapshot()).toMatchObject({
      errors: {},
      features: {
        completion: true,
        promptListChanged: true,
        prompts: true,
        resourceListChanged: true,
        resourceSubscriptions: true,
        resources: true,
        toolListChanged: true,
        tools: true,
      },
      prompts: PROMPTS,
      resources: RESOURCES,
      resourceTemplates: TEMPLATES,
      subscription: {
        honoredFilter: {
          promptsListChanged: true,
          resourcesListChanged: true,
          toolsListChanged: true,
        },
        mode: 'modern-listen',
        state: 'listening',
      },
      tools: TOOLS,
    });
    expect(fixture.client.listen).toHaveBeenCalledWith(
      {
        promptsListChanged: true,
        resourcesListChanged: true,
        toolsListChanged: true,
      },
      expect.any(Object)
    );

    fixture.client.listResources.mockResolvedValueOnce({
      cacheScope: 'private',
      resources: [],
      ttlMs: 1000,
    });
    fixture.client.listResourceTemplates.mockResolvedValueOnce({ resourceTemplates: [] });
    await fixture.handlers()?.onResourceListChanged?.();
    expect(fixture.client.listResources).toHaveBeenCalledTimes(2);
    expect(fixture.client.listResourceTemplates).toHaveBeenCalledTimes(2);
    expect(fixture.client.listTools).toHaveBeenCalledOnce();
    expect(fixture.client.listPrompts).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenCalled();

    await expect(
      features.invoke(operation({ type: 'resources/read', uri: 'linear://issue/BST-1471' }), {})
    ).resolves.toEqual({
      contents: [{ text: '# BST-1471', uri: 'linear://issue/BST-1471' }],
    });
    await features.invoke(
      operation({ type: 'resources/subscribe', uri: 'linear://issue/BST-1471' }),
      {}
    );
    expect(fixture.firstSubscription.close).toHaveBeenCalledOnce();
    expect(fixture.client.listen).toHaveBeenLastCalledWith(
      {
        promptsListChanged: true,
        resourceSubscriptions: ['linear://issue/BST-1471'],
        resourcesListChanged: true,
        toolsListChanged: true,
      },
      expect.any(Object)
    );
    expect(fixture.client.subscribeResource).not.toHaveBeenCalled();
    await features.close();
  });

  it('uses legacy subscribe verbs and never sends modern listen to a legacy server', async () => {
    const fixture = createClient('legacy');
    const features = createMcpCoreServerFeatures(fixture.client);
    await features.initialize();

    expect(features.snapshot().subscription).toEqual({
      mode: 'legacy-unsolicited',
      state: 'listening',
    });
    expect(fixture.client.listen).not.toHaveBeenCalled();

    await features.invoke(
      operation({ type: 'resources/subscribe', uri: 'linear://issue/BST-1471' }),
      {}
    );
    await features.invoke(
      operation({ type: 'resources/unsubscribe', uri: 'linear://issue/BST-1471' }),
      {}
    );
    expect(fixture.client.subscribeResource).toHaveBeenCalledWith(
      { uri: 'linear://issue/BST-1471' },
      expect.any(Object)
    );
    expect(fixture.client.unsubscribeResource).toHaveBeenCalledWith(
      { uri: 'linear://issue/BST-1471' },
      expect.any(Object)
    );
    expect(fixture.client.listen).not.toHaveBeenCalled();
    await features.close();
  });

  it('re-listens with bounded backoff only after remote closure', async () => {
    const firstClosed = Promise.withResolvers<'graceful' | 'local' | 'remote'>();
    const secondClosed = Promise.withResolvers<'graceful' | 'local' | 'remote'>();
    const fixture = createClient();
    fixture.firstSubscription.closed = firstClosed.promise;
    const second = subscription({ toolsListChanged: true }, secondClosed.promise);
    fixture.client.listen
      .mockResolvedValueOnce(fixture.firstSubscription)
      .mockResolvedValueOnce(second);
    const backoff = vi.fn(async (_attempt: number, _signal: AbortSignal) => undefined);
    const features = createMcpCoreServerFeatures(fixture.client, { backoff });
    await features.initialize();

    firstClosed.resolve('remote');
    await vi.waitFor(() => expect(fixture.client.listen).toHaveBeenCalledTimes(2));
    expect(backoff).toHaveBeenCalledWith(1, expect.any(AbortSignal));

    secondClosed.resolve('graceful');
    await vi.waitFor(() =>
      expect(features.snapshot().subscription).toMatchObject({ state: 'closed' })
    );
    expect(fixture.client.listen).toHaveBeenCalledTimes(2);
    await features.close();
  });

  it('resets the retry budget after every successful replacement subscription', async () => {
    const fixture = createClient();
    const closures = Array.from({ length: 5 }, () =>
      Promise.withResolvers<'graceful' | 'local' | 'remote'>()
    );
    const subscriptions = closures.map((closure) =>
      subscription({ toolsListChanged: true }, closure.promise)
    );
    fixture.client.listen.mockReset();
    for (const next of subscriptions) {
      fixture.client.listen.mockResolvedValueOnce(next);
    }
    const backoff = vi.fn(async (_attempt: number, _signal: AbortSignal) => undefined);
    const features = createMcpCoreServerFeatures(fixture.client, { backoff });
    await features.initialize();

    for (let index = 0; index < closures.length - 1; index += 1) {
      closures[index]?.resolve('remote');
      await vi.waitFor(() => expect(fixture.client.listen).toHaveBeenCalledTimes(index + 2));
    }

    expect(backoff).toHaveBeenCalledTimes(closures.length - 1);
    expect(backoff.mock.calls.map(([attempt]) => attempt)).toEqual([1, 1, 1, 1]);
    await features.close();
  });

  it('stops after three consecutive failed re-listen attempts and reports every raw cause', async () => {
    const firstClosed = Promise.withResolvers<'graceful' | 'local' | 'remote'>();
    const fixture = createClient();
    fixture.firstSubscription.closed = firstClosed.promise;
    const failures = [new Error('listen one'), new Error('listen two'), new Error('listen three')];
    fixture.client.listen
      .mockResolvedValueOnce(fixture.firstSubscription)
      .mockRejectedValueOnce(failures[0])
      .mockRejectedValueOnce(failures[1])
      .mockRejectedValueOnce(failures[2]);
    const backoff = vi.fn(async (_attempt: number, _signal: AbortSignal) => undefined);
    const onInternalError = vi.fn();
    const features = createMcpCoreServerFeatures(fixture.client, { backoff, onInternalError });
    await features.initialize();

    firstClosed.resolve('remote');
    await vi.waitFor(() => expect(fixture.client.listen).toHaveBeenCalledTimes(4));
    await vi.waitFor(() =>
      expect(features.snapshot().errors.subscription).toMatchObject({
        code: 'mcp-subscription-failed',
      })
    );

    expect(backoff.mock.calls.map(([attempt]) => attempt)).toEqual([1, 2, 3]);
    expect(onInternalError.mock.calls).toEqual(
      failures.map((failure) => ['mcp-subscription-failed', failure])
    );
    await features.close();
  });

  it('returns cursor pages without replacing complete catalog snapshots', async () => {
    const fixture = createClient();
    const features = createMcpCoreServerFeatures(fixture.client);
    await features.initialize();
    const pages = {
      prompts: { nextCursor: 'p2', prompts: [{ name: 'page-two' }] },
      resources: {
        cacheScope: 'private' as const,
        nextCursor: 'r2',
        resources: [{ name: 'page-two', uri: 'linear://issue/BST-2' }],
        ttlMs: 1000,
      },
      resourceTemplates: {
        nextCursor: 'rt2',
        resourceTemplates: [{ name: 'page-two', uriTemplate: 'linear://issue/{id}' }],
      },
      tools: {
        nextCursor: 't2',
        tools: [{ inputSchema: { type: 'object' as const }, name: 'page_two' }],
      },
    };
    fixture.client.listPrompts.mockResolvedValueOnce(pages.prompts);
    fixture.client.listResources.mockResolvedValueOnce(pages.resources);
    fixture.client.listResourceTemplates.mockResolvedValueOnce(pages.resourceTemplates);
    fixture.client.listTools.mockResolvedValueOnce(pages.tools);

    await expect(
      features.invoke(operation({ cursor: 'p1', type: 'prompts/list' }), {})
    ).resolves.toBe(pages.prompts);
    await expect(
      features.invoke(operation({ cursor: 'r1', type: 'resources/list' }), {})
    ).resolves.toBe(pages.resources);
    await expect(
      features.invoke(operation({ cursor: 'rt1', type: 'resources/templates/list' }), {})
    ).resolves.toBe(pages.resourceTemplates);
    await expect(
      features.invoke(operation({ cursor: 't1', type: 'tools/list' }), {})
    ).resolves.toBe(pages.tools);

    expect(features.snapshot()).toMatchObject({
      prompts: PROMPTS,
      resources: RESOURCES,
      resourceTemplates: TEMPLATES,
      tools: TOOLS,
    });
    await features.close();
  });

  it('keeps raw catalog failures internal while publishing a generic browser error', async () => {
    const fixture = createClient();
    const raw = new Error('authorization=Bearer secret');
    fixture.client.listTools.mockRejectedValueOnce(raw);
    const onInternalError = vi.fn();
    const features = createMcpCoreServerFeatures(fixture.client, { onInternalError });

    await features.initialize();

    expect(onInternalError).toHaveBeenCalledWith('mcp-tools-failed', raw);
    expect(features.snapshot().errors.tools).toEqual({
      category: 'operation',
      code: 'mcp-tools-failed',
      message: 'MCP catalog operation failed',
    });
    expect(JSON.stringify(features.snapshot())).not.toContain('Bearer secret');
    await features.close();
  });

  it('commits modern resource filters only after acknowledged listen and rolls back failures', async () => {
    const fixture = createClient();
    const raw = new Error('replacement rejected');
    fixture.client.listen
      .mockResolvedValueOnce(fixture.firstSubscription)
      .mockRejectedValueOnce(raw);
    const onInternalError = vi.fn();
    const features = createMcpCoreServerFeatures(fixture.client, { onInternalError });
    await features.initialize();

    await expect(
      features.invoke(
        operation({ type: 'resources/subscribe', uri: 'linear://issue/BST-1471' }),
        {}
      )
    ).rejects.toBe(raw);

    expect(fixture.firstSubscription.close).not.toHaveBeenCalled();
    expect(features.snapshot().subscription).toMatchObject({
      honoredFilter: {
        promptsListChanged: true,
        resourcesListChanged: true,
        toolsListChanged: true,
      },
      state: 'listening',
    });
    expect(onInternalError).toHaveBeenCalledWith('mcp-subscription-failed', raw);
    await features.close();
  });

  it('cancels queued and in-flight modern filter changes without committing or leaking', async () => {
    const fixture = createClient();
    const pending = Promise.withResolvers<ReturnType<typeof subscription>>();
    const candidate = subscription({ resourceSubscriptions: ['linear://issue/BST-1'] });
    fixture.client.listen
      .mockResolvedValueOnce(fixture.firstSubscription)
      .mockImplementationOnce(async () => await pending.promise);
    const features = createMcpCoreServerFeatures(fixture.client);
    await features.initialize();
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const first = features.invoke(
      operation({ type: 'resources/subscribe', uri: 'linear://issue/BST-1' }),
      { signal: firstAbort.signal }
    );
    await vi.waitFor(() => expect(fixture.client.listen).toHaveBeenCalledTimes(2));
    const second = features.invoke(
      operation({ type: 'resources/subscribe', uri: 'linear://issue/BST-2' }),
      { signal: secondAbort.signal }
    );
    secondAbort.abort(new DOMException('queued cancellation', 'AbortError'));
    firstAbort.abort(new DOMException('in-flight cancellation', 'AbortError'));
    pending.resolve(candidate);

    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    expect(candidate.close).toHaveBeenCalledOnce();
    expect(fixture.client.listen).toHaveBeenCalledTimes(2);
    expect(fixture.firstSubscription.close).not.toHaveBeenCalled();
    expect(features.snapshot().subscription).toMatchObject({
      honoredFilter: {
        promptsListChanged: true,
        resourcesListChanged: true,
        toolsListChanged: true,
      },
      state: 'listening',
    });
    await features.close();
  });
});

describe('tools/call routing with MCP Tasks registered (BST-1566)', () => {
  function createTasksRegistry() {
    const registry = new McpClientExtensionRegistry();
    registerMcpTasksWireContracts(registry);
    return registry;
  }

  it('dispatches through the registered task-result contract only when the server advertises Tasks', async () => {
    const { client } = createClient();
    const requestExtension = vi.fn(async () => ({
      createdAt: '2026-09-01T05:00:00.000Z',
      lastUpdatedAt: '2026-09-01T05:00:00.000Z',
      resultType: 'task' as const,
      status: 'working' as const,
      taskId: 'task-1',
      ttlMs: null,
    })) as unknown as NonNullable<McpCoreFeatureClient['requestExtension']>;
    const taskClient = {
      ...client,
      getServerCapabilities: vi.fn(() => ({
        extensions: { 'io.modelcontextprotocol/tasks': {} },
        tools: { listChanged: true },
      })),
      requestExtension,
    } satisfies McpCoreFeatureClient;
    const features = createMcpCoreServerFeatures(taskClient, {
      extensionRegistry: createTasksRegistry(),
    });
    await features.initialize();
    await expect(
      features.invoke(
        operation({ arguments: { value: 1 }, toolName: 'long_job', type: 'tools/call' }),
        {}
      )
    ).resolves.toMatchObject({ resultType: 'task', taskId: 'task-1' });
    expect(requestExtension).toHaveBeenCalledWith(
      MCP_TASKS_CALL_TOOL_REQUEST_CONTRACT,
      { arguments: { value: 1 }, name: 'long_job' },
      { resetTimeoutOnProgress: true, signal: expect.any(AbortSignal) }
    );
    expect(taskClient.callTool).not.toHaveBeenCalled();
    await expect(
      features.invoke(
        operation({ _meta: { progressToken: 1 }, toolName: 'long_job', type: 'tools/call' }),
        {}
      )
    ).rejects.toThrow(/cannot carry _meta or task on the MCP Tasks call path/u);
    await features.close();
  });

  it('forwards progress and the progress-reset timeout on the Tasks call path exactly like the core path', async () => {
    const { client } = createClient();
    const requestExtensionMock = vi.fn(
      async (_contract: unknown, _params: unknown, options: { onprogress?: unknown }) => {
        if (typeof options.onprogress !== 'function') {
          throw new Error('expected onprogress on the Tasks call path');
        }
        options.onprogress({ message: 'half', progress: 1, total: 2 });
        return { content: [{ text: 'done', type: 'text' as const }] };
      }
    );
    const taskClient = {
      ...client,
      getServerCapabilities: vi.fn(() => ({
        extensions: { 'io.modelcontextprotocol/tasks': {} },
        tools: { listChanged: true },
      })),
      requestExtension: requestExtensionMock as unknown as NonNullable<
        McpCoreFeatureClient['requestExtension']
      >,
    } satisfies McpCoreFeatureClient;
    const features = createMcpCoreServerFeatures(taskClient, {
      extensionRegistry: createTasksRegistry(),
    });
    await features.initialize();
    const onProgress = vi.fn();
    const signal = new AbortController().signal;
    await features.invoke(operation({ toolName: 'long_job', type: 'tools/call' }), {
      onProgress,
      signal,
    });
    expect(onProgress).toHaveBeenCalledWith({ message: 'half', progress: 1, total: 2 });
    const [, , forwarded] = requestExtensionMock.mock.calls[0] as unknown as [
      unknown,
      unknown,
      Record<string, unknown>,
    ];
    expect(forwarded).toMatchObject({ onprogress: onProgress, resetTimeoutOnProgress: true });
    expect(forwarded['signal']).toBeInstanceOf(AbortSignal);
    // The caller's signal is merged, not dropped, on the Tasks path.
    expect((forwarded['signal'] as AbortSignal).aborted).toBe(false);
    await features.close();
  });

  it('keeps the core callTool path when Tasks are registered but not advertised, or not registered', async () => {
    for (const extensionRegistry of [createTasksRegistry(), undefined]) {
      const { client } = createClient();
      const requestExtension = vi.fn() as unknown as NonNullable<
        McpCoreFeatureClient['requestExtension']
      >;
      const getServerCapabilities = vi.fn(() =>
        extensionRegistry === undefined
          ? { extensions: { 'io.modelcontextprotocol/tasks': {} }, tools: { listChanged: true } }
          : { tools: { listChanged: true } }
      );
      const taskClient = {
        ...client,
        getServerCapabilities,
        requestExtension,
      } satisfies McpCoreFeatureClient;
      const features = createMcpCoreServerFeatures(taskClient, { extensionRegistry });
      await features.initialize();
      await features.invoke(operation({ toolName: 'search', type: 'tools/call' }), {});
      expect(taskClient.callTool).toHaveBeenCalledTimes(1);
      expect(requestExtension).not.toHaveBeenCalled();
      await features.close();
    }
  });
});
