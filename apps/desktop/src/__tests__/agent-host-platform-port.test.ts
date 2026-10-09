// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { ToolInputError } from '@brainstrike/assistant-contract';
import { expect, it, vi } from 'vitest';
import { CancellationTokenSource, type MessageConnection } from 'vscode-jsonrpc/node';
import {
  mainPlatformConnection,
  type PlatformMessagePort,
} from '../agent-host-platform/connection';
import type { DesktopAdmissionReads } from '../agent-host-platform/desktop-run-admission';
import {
  type DesktopPlatformCapabilities,
  serveDesktopPlatform,
} from '../agent-host-platform/main-platform';
import { createDesktopMcpPlatformCapabilities } from '../mcp/desktop-host-platform';
import { MainMcpHostControl } from '../mcp/main-host-control';
import { mainReads } from './fixtures/desktop-admission-reads';

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
/** Main lends a thread's bound workspace under the lease the host names. */
function lending(
  close = vi.fn(async () => undefined),
  roots: Awaited<ReturnType<DesktopAdmissionReads['acquireWorkspace']>>['roots'] = []
): DesktopAdmissionReads {
  return mainReads({
    acquireWorkspace: async () => ({ close, revalidate: async () => undefined, roots }),
  });
}
function harness(
  admission: DesktopAdmissionReads,
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
    admission,
    mcp: createDesktopMcpPlatformCapabilities(new MainMcpHostControl()),
    ...(closeRootCapabilities ? { closeRootCapabilities } : {}),
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
    const f = harness(mainReads(), closeRoot);
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

const BINDING = { operatingRootDisplayName: 'Bound', operatingRootId: 'root-bound' };

/** The host borrows a thread's bound workspace for a run. */
async function acquire(
  client: MessageConnection,
  token?: CancellationTokenSource['token']
): Promise<unknown> {
  const params = { binding: BINDING, leaseId: randomUUID(), threadId: 'thread' };
  return token
    ? client.sendRequest('platform/admission/workspace/acquire', params, token)
    : client.sendRequest('platform/admission/workspace/acquire', params);
}

const LIST_TABLES = {
  request: { input: { mode: 'listTables', target: 'app' } },
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

it('utility loss aborts an in-flight Main read and joins its physical tail before returning the workspace lease', async () => {
  const physicalTail = Promise.withResolvers<void>();
  const serverClosed = Promise.withResolvers<void>();
  const release = vi.fn(async () => undefined);
  const read = heldRead(physicalTail.promise);
  const h = harness(lending(release), undefined, { querySelf: read.querySelf });
  h.server.onClose(() => serverClosed.resolve());
  try {
    await acquire(h.client);
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
  const h = harness(lending(close), undefined, { querySelf: read.querySelf });
  const cancellation = new CancellationTokenSource();
  let settled = false;
  try {
    await acquire(h.client);
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

it('an aborted acquisition returns the arriving borrow and keeps its cleanup failure', async () => {
  const entered = Promise.withResolvers<AbortSignal>();
  const release = Promise.withResolvers<void>();
  const cleanup = new Error('fixture cleanup failure');
  const close = vi.fn(async () => {
    throw cleanup;
  });
  const h = harness(
    mainReads({
      acquireWorkspace: async ({ signal }) => {
        entered.resolve(signal);
        await release.promise;
        return { close, revalidate: async () => undefined, roots: [] };
      },
    })
  );
  const cancellation = new CancellationTokenSource();
  try {
    const acquired = acquire(h.client, cancellation.token);
    acquired.catch(() => undefined);
    const signal = await entered.promise;
    cancellation.cancel();
    // Main learns the host stopped waiting while the borrow is still arriving.
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
    expect(close).not.toHaveBeenCalled();
    release.resolve();
    const failure = await acquired.catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain('Workspace acquisition and cleanup failed');
    expect(close).toHaveBeenCalledTimes(1);
    // The refused borrow is not held: closing Main returns nothing twice.
    await h.owner.close();
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    release.resolve();
    cancellation.dispose();
    h.destroy();
  }
});

it('a borrow whose roots cannot cross the wire is returned before the acquisition fails', async () => {
  const close = vi.fn(async () => undefined);
  // The wire's root ids are nonempty: this root cannot cross to the host.
  const h = harness(lending(close, [{ displayName: 'Bound', path: '/bound', rootId: '' }]));
  try {
    await expect(acquire(h.client)).rejects.toBeInstanceOf(Error);
    expect(close).toHaveBeenCalledTimes(1);
    await h.owner.close();
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    h.destroy();
  }
});

it('serves a host command’s worktree snapshot and completion to Main’s correlation', async () => {
  const completed = vi.fn(async () => []);
  const h = harness(mainReads(), undefined, {
    shell: { completed, worktreePaths: async () => ['/repo/.worktrees/fox'] },
  });
  try {
    await expect(
      h.client.sendRequest('platform/worktree/paths', { threadId: 'thread' })
    ).resolves.toEqual({ paths: ['/repo/.worktrees/fox'] });
    const completion = {
      command: 'git worktree add ../fox',
      precedingWorktreePaths: ['/repo/.worktrees/fox'],
      rootId: 'root-a',
      runId: 'host-run',
      threadId: 'thread',
    };
    await expect(
      h.client.sendRequest('platform/shell/completed', { ...completion })
    ).resolves.toEqual({ adopted: [] });
    expect(completed).toHaveBeenCalledWith(completion);
  } finally {
    h.destroy();
  }
});

it('serves grep’s indexed half to the host', async () => {
  const result = {
    candidatesTruncated: false,
    matches: [],
    scanLimited: false,
    skippedMissingLineMetadata: 0,
    totalMatches: 0,
    truncated: false,
  };
  const grepIndex = vi.fn(async () => result);
  const h = harness(mainReads(), undefined, { grepIndex });
  const request = {
    options: { maxResults: 5, pattern: 'needle' },
    threadId: 'thread',
  };
  try {
    await expect(h.client.sendRequest('desktop-read/grep-index', request)).resolves.toEqual(result);
    expect(grepIndex).toHaveBeenCalledWith({ maxResults: 5, pattern: 'needle' });
  } finally {
    h.destroy();
  }
});

it('serves the workspace index, retrieval catalog and query embedding to the host', async () => {
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
    mainReads(),
    undefined,
    { indexSearch, retrievalStore },
    // Main's one embedding host relay serves the retrieval tools' queries too.
    {
      queryEmbedding: async (payload, options) =>
        await queryEmbedding(payload, options?.signal ?? new AbortController().signal),
    }
  );
  const statusRead = { request: {}, threadId: 'thread' };
  try {
    await expect(h.client.sendRequest('desktop-read/index/status', statusRead)).resolves.toEqual(
      status
    );
    await expect(
      h.client.sendRequest('desktop-read/retrieval/embedding-set', {
        request: { embeddingSetId: 'selected' },
        threadId: 'thread',
      })
    ).resolves.toEqual(set);
    expect(retrievalStore.embeddingSet).toHaveBeenCalledWith('selected');
    const payload = { dimensions: 2, modelId: 'model', modelKey: 'local::model', query: 'marker' };
    await expect(
      h.client.sendRequest('platform/embedding/query', { request: payload })
    ).resolves.toEqual([0.5, 0.25]);
    expect(queryEmbedding).toHaveBeenCalledWith(payload, expect.any(AbortSignal));
  } finally {
    h.destroy();
  }
});

it('serves the worktree calls under the calling run’s identity', async () => {
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
  const h = harness(mainReads(), undefined, { worktrees });
  const params = { baseRef: 'HEAD', branch: 'bs/fox', name: 'fox', rootId: 'root-a' };
  try {
    await expect(
      h.client.sendRequest('platform/worktree/list', { threadId: 'thread' })
    ).resolves.toEqual({ ok: true, value: [] });
    await expect(
      h.client.sendRequest('platform/worktree/create', {
        params,
        runId: 'host-run',
        threadId: 'thread',
      })
    ).resolves.toEqual(created);
    expect(worktrees).toHaveBeenLastCalledWith({ runId: 'host-run', threadId: 'thread' });
    expect(service.create).toHaveBeenCalledWith(params);
  } finally {
    h.destroy();
  }
});

it('drives the browser pane, re-parsing the tool input', async () => {
  const browser = {
    getPageText: vi.fn(),
    navigate: vi.fn(async () => ({
      ok: true as const,
      title: 'Example',
      url: 'https://example.com/',
    })),
    readPage: vi.fn(),
  };
  const h = harness(mainReads(), undefined, { browser });
  const navigate = {
    input: { url: 'https://example.com' },
    threadId: 'thread',
  };
  try {
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
        threadId: 'thread',
      })
    ).rejects.toBeInstanceOf(Error);
    expect(browser.navigate).toHaveBeenCalledOnce();
  } finally {
    h.destroy();
  }
});

it('delivers a validated context write-back to the windows', async () => {
  const contextDelivery = { selection: vi.fn(async () => 2), tapestry: vi.fn() };
  const h = harness(mainReads(), undefined, { contextDelivery });
  const delivery = {
    payload: { filePaths: ['notes.txt'], folderId: 'folder-a', mode: 'add' },
    threadId: 'thread',
  };
  try {
    await expect(
      h.client.sendRequest('platform/workspace-context/selection', delivery)
    ).resolves.toEqual({ notifiedWindowCount: 2 });
    expect(contextDelivery.selection).toHaveBeenCalledWith(delivery.payload);
  } finally {
    h.destroy();
  }
});

it('serves querySelf’s SQL read and the diagnostics store to the host', async () => {
  const querySelf = vi.fn(async (read: { input: { sql?: string } }) => {
    if (read.input.sql === 'SELEC 1') {
      throw new ToolInputError('syntax error at or near "SELEC"');
    }
    return { analyzed: false, kind: 'plan' as const, plan: ['Result'], target: 'app' as const };
  });
  const diagnostics = { events: vi.fn(async () => []), fingerprints: vi.fn() };
  const h = harness(mainReads(), undefined, { diagnostics, querySelf });
  const read = (sql: string) => ({
    request: { input: { mode: 'explain', sql, target: 'app' } },
    threadId: 'thread',
  });
  try {
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
        threadId: 'thread',
      })
    ).resolves.toEqual([]);
    expect(diagnostics.events).toHaveBeenCalledWith({ limit: 5 });
  } finally {
    h.destroy();
  }
});
