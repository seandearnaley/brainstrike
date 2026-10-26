// @vitest-environment node

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { INTERNAL_FAULT } from '@brainstrike/assistant-contract';
import { addLogListener, type LogRecord } from '@brainstrike/logging';
import { expect, it, vi } from 'vitest';
import {
  CancellationTokenSource,
  ErrorCodes,
  type MessageConnection,
  ResponseError,
} from 'vscode-jsonrpc/node';
import {
  mainPlatformConnection,
  type PlatformMessagePort,
} from '../agent-host-platform/connection';
import type { DesktopAdmissionReads } from '../agent-host-platform/desktop-run-admission';
import {
  type DesktopPlatformCapabilities,
  serveDesktopPlatform,
} from '../agent-host-platform/main-platform';
import { canonicalError, canonicalFault } from '../canonical-utility-protocol';
import { HostedEmbeddingError } from '../hosted-embedding-error';
import { hostedQueryEmbedding } from '../hosted-embeddings';
import { createDesktopMcpPlatformCapabilities } from '../mcp/desktop-host-platform';
import { MainMcpHostControl } from '../mcp/main-host-control';
import { mainReads } from './fixtures/desktop-admission-reads';

// Main's hosted query embedding, answered by the test that reaches it.
vi.mock('../hosted-embeddings', async (original) => ({
  ...(await original<typeof import('../hosted-embeddings')>()),
  hostedQueryEmbedding: vi.fn(),
}));

/** Real Node ports with the Electron utility port's public MessageEvent shape. */
class UtilityPort extends EventEmitter implements PlatformMessagePort {
  private readonly port: MessagePort;

  constructor(port: MessagePort) {
    super();
    this.port = port;
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
  hostTools?: DesktopPlatformCapabilities['hostTools']
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

it('acknowledges capability binding through the private platform readiness request', async () => {
  const f = harness(mainReads());
  try {
    await expect(f.client.sendRequest('platform/ready', {})).resolves.toBeNull();
    await expect(f.client.sendRequest('platform/ready', { partial: true })).rejects.toThrow();
  } finally {
    f.destroy();
  }
});

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

/** An error as the logger keeps it: each nested failure with its own message. */
interface LoggedError {
  readonly errors?: readonly LoggedError[];
  readonly message: string;
}

it('a failed private close logs every inner failure in Main and sends the host the typed internal fault (BST-2192)', async () => {
  // Hosted run 39164110759: the host's close got only "Desktop platform capability
  // cleanup failed", kept its Root, and never exited. Nothing said which retirement failed.
  const workspace = new Error('Workspace close failed');
  const native = new Error('Native Root retirement failed');
  const closeRoot = vi.fn(async (): Promise<void> => {
    throw new AggregateError(
      [workspace, native],
      'Desktop workspace and native Root retirement failed'
    );
  });
  const records: LogRecord[] = [];
  const unsubscribe = addLogListener((record) => records.push(record));
  const f = harness(mainReads(), closeRoot);
  try {
    const failure = await f.client
      .sendRequest('platform/close', {})
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(ResponseError);
    const response = failure as ResponseError<unknown>;
    expect(response.data).toEqual({ ...INTERNAL_FAULT, correlationId: expect.any(String) });
    const correlationId = (response.data as { correlationId: string }).correlationId;
    const logged = records.find(
      (record) =>
        record.level === 'error' &&
        record.args.some(
          (arg) =>
            typeof arg === 'object' &&
            arg !== null &&
            'correlationId' in arg &&
            arg.correlationId === correlationId
        )
    );
    expect(logged?.scope).toBe('DesktopMainPlatform');
    const fields = logged?.args.find(
      (arg) => typeof arg === 'object' && arg !== null && 'error' in arg
    ) as { error: LoggedError };
    expect(fields.error.message).toBe('Desktop platform capability cleanup failed');
    expect(fields.error.errors?.[0]?.errors?.map((error) => error.message)).toEqual([
      workspace.message,
      native.message,
    ]);
    await expect(f.owner.close()).rejects.toThrow('Desktop platform capability cleanup failed');
  } finally {
    unsubscribe();
    f.destroy();
  }
});

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

const DIAGNOSTIC_EVENTS = { filter: { limit: 5 }, threadId: 'thread' };

/** A diagnostics read that holds until its physical tail is released. */
function heldRead(tail: Promise<void>) {
  const entered = Promise.withResolvers<void>();
  const diagnostics = {
    events: vi.fn(async () => {
      entered.resolve();
      await tail;
      return [];
    }),
    fingerprints: vi.fn(),
  };
  return { diagnostics, entered: entered.promise };
}

it('utility loss joins an in-flight Main read’s physical tail before returning the workspace lease', async () => {
  const physicalTail = Promise.withResolvers<void>();
  const serverClosed = Promise.withResolvers<void>();
  const release = vi.fn(async () => undefined);
  const read = heldRead(physicalTail.promise);
  const h = harness(lending(release), undefined, { diagnostics: read.diagnostics });
  h.server.onClose(() => serverClosed.resolve());
  try {
    await acquire(h.client);
    const reading = h.client.sendRequest('desktop-read/diagnostics/events', DIAGNOSTIC_EVENTS);
    reading.catch(() => undefined);
    await read.entered;
    h.crash();
    await serverClosed.promise;
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
  const h = harness(lending(close), undefined, { diagnostics: read.diagnostics });
  const cancellation = new CancellationTokenSource();
  let settled = false;
  try {
    await acquire(h.client);
    const reading = h.client.sendRequest(
      'desktop-read/diagnostics/events',
      DIAGNOSTIC_EVENTS,
      cancellation.token
    );
    reading.catch(() => undefined);
    await read.entered;
    cancellation.cancel();
    const closing = h.owner.close().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(close).not.toHaveBeenCalled();
    joined.resolve();
    // This read does not observe its signal, so it settles with its result.
    await expect(reading).resolves.toEqual([]);
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
  const records: LogRecord[] = [];
  const unsubscribe = addLogListener((record) => records.push(record));
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
    expect(failure).toBeInstanceOf(ResponseError);
    const response = failure as ResponseError<unknown>;
    expect(response.code).toBe(ErrorCodes.InternalError);
    expect(response.data).toEqual({ ...INTERNAL_FAULT, correlationId: expect.any(String) });
    const correlationId = (response.data as { correlationId: string }).correlationId;
    const fields = records
      .flatMap((record) => record.args)
      .find(
        (arg) =>
          typeof arg === 'object' &&
          arg !== null &&
          'correlationId' in arg &&
          arg.correlationId === correlationId
      ) as { error: { name: string; errors: readonly { message: string }[] } };
    expect(fields.error.name).toBe('AggregateError');
    expect(fields.error.errors.map((error) => error.message)).toEqual([
      signal.reason.message,
      cleanup.message,
    ]);
    expect(close).toHaveBeenCalledTimes(1);
    // The refused borrow is not held: closing Main returns nothing twice.
    await h.owner.close();
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    unsubscribe();
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
  const set = {
    dimensions: 1536,
    distance: 'cosine',
    modelId: 'text-embedding-3-small',
    modelKey: 'openai::text-embedding-3-small',
  };
  const retrievalStore = {
    embeddingSet: vi.fn(async () => set),
    embeddingSpaces: vi.fn(async () => []),
    fileRecords: vi.fn(async () => new Map()),
  };
  vi.mocked(hostedQueryEmbedding).mockImplementationOnce(async (_payload, signal) => {
    expect(signal).toBeInstanceOf(AbortSignal);
    return [0.5, 0.25];
  });
  const h = harness(mainReads(), undefined, { indexSearch, retrievalStore });
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
    ).resolves.toEqual({ ok: true, result: set });
    expect(retrievalStore.embeddingSet).toHaveBeenCalledWith('selected');
    const payload = {
      dimensions: 2,
      modelId: 'text-embedding-3-small',
      modelKey: 'openai::text-embedding-3-small',
      query: 'marker',
    };
    await expect(
      h.client.sendRequest('platform/embedding/query', { request: payload })
    ).resolves.toEqual({ ok: true, result: [0.5, 0.25] });
    expect(hostedQueryEmbedding).toHaveBeenCalledWith(payload, expect.any(AbortSignal));
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

it('serves the diagnostics store to the host', async () => {
  const diagnostics = { events: vi.fn(async () => []), fingerprints: vi.fn() };
  const h = harness(mainReads(), undefined, { diagnostics });
  try {
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

it.each([
  ['missing-key', 'configuration'],
  ['input-too-long', 'input'],
  ['rate-limit', 'availability'],
] as const)('retains typed %s through the real status boundary', async (kind, category) => {
  const original = new HostedEmbeddingError(
    kind,
    'No API key configured for the embedding provider.',
    { cause: new Error('private missing-key fixture') }
  );
  const aggregate = canonicalError(
    canonicalFault(
      new AggregateError([original, original], 'Canonical inference and retirement failed.')
    )
  );
  const indexSearch = {
    coverage: vi.fn(),
    coverageBatch: vi.fn(),
    grep: vi.fn(),
    rebuild: vi.fn(),
    search: vi.fn(),
    status: vi.fn(async () => {
      throw aggregate;
    }),
  };
  const h = harness(mainReads(), undefined, { indexSearch });
  try {
    const received: unknown = await h.client
      .sendRequest('desktop-read/index/status', { request: {}, threadId: 'thread' })
      .catch((error: unknown) => error);
    expect(received).toMatchObject({
      code: -32_001,
      data: {
        category,
        code: `embedding.${kind}`,
        correlationId: expect.any(String),
        kind: 'refusal',
        remedy: expect.any(String),
      },
    });
    expect(JSON.stringify(received)).not.toContain('private missing-key fixture');
  } finally {
    h.destroy();
  }
});
