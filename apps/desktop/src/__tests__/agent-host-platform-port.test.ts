// @vitest-environment node
import { EventEmitter } from 'node:events';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { DEFAULT_PERMISSION_POLICIES, ToolInputError } from '@brainstrike/assistant-contract';
import { expect, it, vi } from 'vitest';
import { CancellationTokenSource, type MessageConnection } from 'vscode-jsonrpc/node';
import {
  mainPlatformConnection,
  type PlatformMessagePort,
} from '../agent-host-platform/connection';
import {
  type DesktopPlatformCapabilities,
  type DesktopPlatformSelection,
  serveDesktopPlatform,
} from '../agent-host-platform/main-platform';
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
  tools: DesktopPlatformSelection['tools'],
  close = vi.fn(async () => undefined)
): DesktopPlatformSelection {
  return {
    close,
    configuration: { model: 'fixture', provider: 'openai' },
    contextWindow: 32_000,
    durableConfiguration: {},
    freshWorkspaceRoots: async () => [],
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
    nativeRuntime: { provider: 'openai', workspaceRoots: [] },
    resourceId: 'workspace',
    tools,
    toolTimeoutMs: 5000,
  };
}
function harness(
  readConfiguration: DesktopPlatformCapabilities['readConfiguration'],
  closeRootCapabilities?: DesktopPlatformCapabilities['closeRootCapabilities'],
  hostTools?: DesktopPlatformCapabilities['hostTools'],
  localEmbedding?: DesktopPlatformCapabilities['localEmbedding']
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
    ...(hostTools ? { hostTools } : {}),
    ...(localEmbedding ? { localEmbedding } : {}),
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
    const f = harness(async () => selected({}), closeRoot);
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

async function admit(client: MessageConnection): Promise<unknown> {
  return client.sendRequest('platform/admit', {
    modelId: 'openai::fixture',
    runId: 'run',
    threadId: 'thread',
  });
}

const LIST_TABLES = {
  request: { input: { mode: 'listTables', target: 'app' } },
  selectionRunId: 'run',
  threadId: 'thread',
};

/** A querySelf read that holds until its physical tail is released. */
function heldRead(tail: Promise<void>) {
  const entered = Promise.withResolvers<AbortSignal>();
  const querySelf = vi.fn(async (_read: unknown, signal?: AbortSignal) => {
    if (!signal) {
      throw new Error('Main supplied no signal to its read');
    }
    entered.resolve(signal);
    await tail;
    signal.throwIfAborted();
    return { analyzed: false, kind: 'plan' as const, plan: [], target: 'app' as const };
  });
  return { entered: entered.promise, querySelf };
}

it('utility loss aborts an in-flight Main read and joins its physical tail before releasing the selection', async () => {
  const physicalTail = Promise.withResolvers<void>();
  const serverClosed = Promise.withResolvers<void>();
  const release = vi.fn(async () => undefined);
  const read = heldRead(physicalTail.promise);
  const h = harness(async () => selected({}, release), undefined, {
    querySelf: read.querySelf,
  });
  h.server.onClose(() => serverClosed.resolve());
  try {
    await admit(h.client);
    const reading = h.client.sendRequest('desktop-read/query-self', LIST_TABLES);
    reading.catch(() => undefined);
    const signal = await read.entered;
    h.crash();
    await serverClosed.promise;
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
    let closed = false;
    const closing = h.owner.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(release).not.toHaveBeenCalled();
    physicalTail.resolve();
    await closing;
    await expect(reading).rejects.toThrow();
    expect(release).toHaveBeenCalledTimes(1);
  } finally {
    physicalTail.resolve();
    h.destroy();
    await h.owner.close();
  }
});

it('cancellation and close wait for an in-flight Main read’s physical tail before releasing borrowed capabilities', async () => {
  const joined = Promise.withResolvers<void>();
  const close = vi.fn(async () => undefined);
  const read = heldRead(joined.promise);
  const h = harness(async () => selected({}, close), undefined, { querySelf: read.querySelf });
  const cancellation = new CancellationTokenSource();
  let settled = false;
  try {
    await admit(h.client);
    const reading = h.client.sendRequest(
      'desktop-read/query-self',
      LIST_TABLES,
      cancellation.token
    );
    reading.catch(() => undefined);
    const signal = await read.entered;
    cancellation.cancel();
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
    const closing = h.owner.close().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(close).not.toHaveBeenCalled();
    joined.resolve();
    await expect(reading).rejects.toBeInstanceOf(Error);
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
      { modelId: 'openai::fixture', runId: 'run', threadId: 'thread' },
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

it('a selection the wire refuses releases before an admission error returns', async () => {
  const close = vi.fn(async () => undefined);
  const h = harness(async () =>
    selected(
      {
        tool: {
          description: 'fixture',
          // The wire's ids are nonempty: this descriptor cannot cross to the host.
          identity: '',
          inputSchema: { type: 'object' },
          permissionToolId: 'tool',
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

it('serves a host command’s worktree snapshot and completion to Main’s correlation, for an admitted thread only', async () => {
  const completed = vi.fn(async () => []);
  const h = harness(async () => selected({}), undefined, {
    shell: { completed, worktreePaths: async () => ['/repo/.worktrees/fox'] },
  });
  try {
    await expect(
      h.client.sendRequest('platform/worktree/paths', { selectionRunId: 'run', threadId: 'thread' })
    ).rejects.toBeInstanceOf(Error);
    await admit(h.client);
    await expect(
      h.client.sendRequest('platform/worktree/paths', { selectionRunId: 'run', threadId: 'thread' })
    ).resolves.toEqual({ paths: ['/repo/.worktrees/fox'] });
    const completion = {
      command: 'git worktree add ../fox',
      precedingWorktreePaths: ['/repo/.worktrees/fox'],
      rootId: 'root-a',
      runId: 'host-run',
      threadId: 'thread',
    };
    // The admitting run reaches Main's selection; the completion itself is unchanged.
    await expect(
      h.client.sendRequest('platform/shell/completed', { ...completion, selectionRunId: 'run' })
    ).resolves.toEqual({ adopted: [] });
    expect(completed).toHaveBeenCalledWith(completion);
  } finally {
    h.destroy();
  }
});

it('serves grep’s indexed half to an admitted thread only', async () => {
  const result = {
    candidatesTruncated: false,
    matches: [],
    scanLimited: false,
    skippedMissingLineMetadata: 0,
    totalMatches: 0,
    truncated: false,
  };
  const grepIndex = vi.fn(async () => result);
  const h = harness(async () => selected({}), undefined, { grepIndex });
  const request = {
    options: { maxResults: 5, pattern: 'needle' },
    selectionRunId: 'run',
    threadId: 'thread',
  };
  try {
    await expect(h.client.sendRequest('desktop-read/grep-index', request)).rejects.toBeInstanceOf(
      Error
    );
    expect(grepIndex).not.toHaveBeenCalled();
    await admit(h.client);
    await expect(h.client.sendRequest('desktop-read/grep-index', request)).resolves.toEqual(result);
    expect(grepIndex).toHaveBeenCalledWith({ maxResults: 5, pattern: 'needle' });
  } finally {
    h.destroy();
  }
});

it('serves the workspace index, retrieval catalog and query embedding to an admitted thread only', async () => {
  const status = { kind: 'unavailable' as const, reason: 'fixture index is offline' };
  const indexSearch = {
    coverage: vi.fn(),
    coverageBatch: vi.fn(),
    grep: vi.fn(),
    rebuild: vi.fn(),
    search: vi.fn(),
    status: vi.fn(async () => status),
  };
  const set = { dimensions: 384, distance: 'cosine', modelId: 'model', modelKey: 'local::model' };
  const retrievalStore = {
    embeddingSet: vi.fn(async () => set),
    embeddingSpaces: vi.fn(async () => []),
    fileRecords: vi.fn(async () => new Map()),
  };
  const queryEmbedding = vi.fn(async (_payload: unknown, signal: AbortSignal) => {
    expect(signal).toBeInstanceOf(AbortSignal);
    return [0.5, 0.25];
  });
  const h = harness(
    async () => selected({}),
    undefined,
    { indexSearch, retrievalStore },
    // Main's one embedding host relay serves the retrieval tools' queries too.
    {
      queryEmbedding: async (payload, options) =>
        await queryEmbedding(payload, options?.signal ?? new AbortController().signal),
    }
  );
  const statusRead = { request: {}, selectionRunId: 'run', threadId: 'thread' };
  try {
    await expect(
      h.client.sendRequest('desktop-read/index/status', statusRead)
    ).rejects.toBeInstanceOf(Error);
    expect(indexSearch.status).not.toHaveBeenCalled();
    await admit(h.client);
    await expect(h.client.sendRequest('desktop-read/index/status', statusRead)).resolves.toEqual(
      status
    );
    await expect(
      h.client.sendRequest('desktop-read/retrieval/embedding-set', {
        request: { embeddingSetId: 'selected' },
        selectionRunId: 'run',
        threadId: 'thread',
      })
    ).resolves.toEqual(set);
    expect(retrievalStore.embeddingSet).toHaveBeenCalledWith('selected');
    const payload = { dimensions: 2, modelId: 'model', modelKey: 'local::model', query: 'marker' };
    await expect(
      h.client.sendRequest('platform/embedding/query', {
        request: payload,
        selectionRunId: 'run',
        threadId: 'thread',
      })
    ).resolves.toEqual([0.5, 0.25]);
    expect(queryEmbedding).toHaveBeenCalledWith(payload, expect.any(AbortSignal));
  } finally {
    h.destroy();
  }
});

it('serves the worktree calls to an admitted thread only, under the calling run’s identity', async () => {
  const created = {
    ok: true as const,
    value: {
      setup: { reason: null, status: 'none' },
      worktree: { branch: 'bs/fox', id: 'wt-9', path: '/managed/fox' },
    },
  };
  const service = {
    archive: vi.fn(),
    create: vi.fn(async () => created),
    list: vi.fn(async () => ({ ok: true as const, value: [] })),
  };
  const worktrees = vi.fn(() => service);
  const h = harness(async () => selected({}), undefined, { worktrees });
  const params = { baseRef: 'HEAD', branch: 'bs/fox', name: 'fox', rootId: 'root-a' };
  try {
    await expect(
      h.client.sendRequest('platform/worktree/create', {
        params,
        runId: 'host-run',
        selectionRunId: 'run',
        threadId: 'thread',
      })
    ).rejects.toBeInstanceOf(Error);
    expect(worktrees).not.toHaveBeenCalled();
    await admit(h.client);
    await expect(
      h.client.sendRequest('platform/worktree/list', { selectionRunId: 'run', threadId: 'thread' })
    ).resolves.toEqual({ ok: true, value: [] });
    await expect(
      h.client.sendRequest('platform/worktree/create', {
        params,
        runId: 'host-run',
        selectionRunId: 'run',
        threadId: 'thread',
      })
    ).resolves.toEqual(created);
    expect(worktrees).toHaveBeenLastCalledWith({ runId: 'host-run', threadId: 'thread' });
    expect(service.create).toHaveBeenCalledWith(params);
  } finally {
    h.destroy();
  }
});

it('drives the browser pane for an admitted thread only, re-parsing the tool input', async () => {
  const browser = {
    getPageText: vi.fn(),
    navigate: vi.fn(async () => ({
      ok: true as const,
      title: 'Example',
      url: 'https://example.com/',
    })),
    readPage: vi.fn(),
  };
  const h = harness(async () => selected({}), undefined, { browser });
  const navigate = {
    input: { url: 'https://example.com' },
    selectionRunId: 'run',
    threadId: 'thread',
  };
  try {
    await expect(
      h.client.sendRequest('platform/browser/navigate', navigate)
    ).rejects.toBeInstanceOf(Error);
    await admit(h.client);
    await expect(h.client.sendRequest('platform/browser/navigate', navigate)).resolves.toEqual({
      ok: true,
      title: 'Example',
      url: 'https://example.com/',
    });
    expect(browser.navigate).toHaveBeenCalledWith({ url: 'https://example.com' });
    // A hallucinated parameter fails Main's strict catalog schema too.
    await expect(
      h.client.sendRequest('platform/browser/navigate', {
        input: { url: 'https://example.com', wait: true },
        selectionRunId: 'run',
        threadId: 'thread',
      })
    ).rejects.toBeInstanceOf(Error);
    expect(browser.navigate).toHaveBeenCalledOnce();
  } finally {
    h.destroy();
  }
});

it('delivers a validated context write-back to the windows for an admitted thread only', async () => {
  const contextDelivery = { selection: vi.fn(async () => 2), tapestry: vi.fn() };
  const h = harness(async () => selected({}), undefined, { contextDelivery });
  const delivery = {
    payload: { filePaths: ['notes.txt'], folderId: 'folder-a', mode: 'add' },
    selectionRunId: 'run',
    threadId: 'thread',
  };
  try {
    await expect(
      h.client.sendRequest('platform/workspace-context/selection', delivery)
    ).rejects.toBeInstanceOf(Error);
    expect(contextDelivery.selection).not.toHaveBeenCalled();
    await admit(h.client);
    await expect(
      h.client.sendRequest('platform/workspace-context/selection', delivery)
    ).resolves.toEqual({ notifiedWindowCount: 2 });
    expect(contextDelivery.selection).toHaveBeenCalledWith(delivery.payload);
  } finally {
    h.destroy();
  }
});

it('serves querySelf’s SQL read and the diagnostics store to an admitted thread only', async () => {
  const querySelf = vi.fn(async (read: { input: { sql?: string } }) => {
    if (read.input.sql === 'SELEC 1') {
      throw new ToolInputError('syntax error at or near "SELEC"');
    }
    return { analyzed: false, kind: 'plan' as const, plan: ['Result'], target: 'app' as const };
  });
  const diagnostics = { events: vi.fn(async () => []), fingerprints: vi.fn() };
  const h = harness(async () => selected({}), undefined, { diagnostics, querySelf });
  const read = (sql: string) => ({
    request: { input: { mode: 'explain', sql, target: 'app' } },
    selectionRunId: 'run',
    threadId: 'thread',
  });
  try {
    await expect(
      h.client.sendRequest('desktop-read/query-self', read('SELECT 1'))
    ).rejects.toBeInstanceOf(Error);
    expect(querySelf).not.toHaveBeenCalled();
    await admit(h.client);
    await expect(
      h.client.sendRequest('desktop-read/query-self', read('SELECT 1'))
    ).resolves.toEqual({
      ok: true,
      result: { analyzed: false, kind: 'plan', plan: ['Result'], target: 'app' },
    });
    // An engine input error crosses as a model-correctable outcome, not a transport failure.
    await expect(h.client.sendRequest('desktop-read/query-self', read('SELEC 1'))).resolves.toEqual(
      {
        error: 'input',
        message: 'syntax error at or near "SELEC"',
        ok: false,
      }
    );
    await expect(
      h.client.sendRequest('desktop-read/diagnostics/events', {
        filter: { limit: 5 },
        selectionRunId: 'run',
        threadId: 'thread',
      })
    ).resolves.toEqual([]);
    expect(diagnostics.events).toHaveBeenCalledWith({ limit: 5 });
  } finally {
    h.destroy();
  }
});
