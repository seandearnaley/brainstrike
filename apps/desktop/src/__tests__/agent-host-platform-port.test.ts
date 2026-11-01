// @vitest-environment node

import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import type { CredentialCipher } from '@brainstrike/agent-host/credential-contract';
import { INTERNAL_FAULT } from '@brainstrike/assistant-contract';
import { createHostCredentials } from '@brainstrike/host-capabilities/credentials';
import { addLogListener, type LogRecord } from '@brainstrike/logging';
import { expect, it, vi } from 'vitest';
import { CancellationTokenSource, ResponseError } from 'vscode-jsonrpc/node';
import {
  mainPlatformConnection,
  type PlatformMessagePort,
} from '../agent-host-platform/connection';
import type { DesktopAdmissionReads } from '../agent-host-platform/desktop-run-admission';
import { lentCredentialCipher } from '../agent-host-platform/lent-credential-cipher';
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
function harness(
  admission: DesktopAdmissionReads,
  closeRootCapabilities?: DesktopPlatformCapabilities['closeRootCapabilities'],
  hostTools?: DesktopPlatformCapabilities['hostTools'],
  credentialCipher?: CredentialCipher
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
    ...(credentialCipher ? { credentialCipher } : {}),
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

it('the host seals its credential file with the cipher Main lends, and Main reads it back', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bs-sealed-credentials-'));
  const selection = {
    kind: 'sealed-file',
    path: join(directory, 'brainstrike-credentials.sealed.json'),
  } as const;
  // Main's safeStorage stand-in: only what it sealed opens.
  const mainCipher: CredentialCipher = {
    open: async (sealed) => {
      const text = Buffer.from(sealed, 'base64').toString('utf8');
      if (!text.startsWith('main:')) {
        throw new Error('Not sealed by Main');
      }
      return text.slice('main:'.length);
    },
    seal: async (plaintext) => Buffer.from(`main:${plaintext}`).toString('base64'),
  };
  const f = harness(mainReads(), undefined, undefined, mainCipher);
  const host = createHostCredentials({
    cipher: lentCredentialCipher((method, input) => f.client.sendRequest(method, input)),
    selection,
  });
  const main = createHostCredentials({ cipher: mainCipher, selection });
  try {
    await host.secrets().saveKey('openrouter', 'sk-or-sealed-by-main');
    expect(await readFile(selection.path, 'utf8')).not.toContain('sk-or-sealed-by-main');
    await expect(main.secrets().getKey('openrouter')).resolves.toBe('sk-or-sealed-by-main');
    await expect(host.secrets().getKey('openrouter')).resolves.toBe('sk-or-sealed-by-main');
  } finally {
    await Promise.all([host.close(), main.close()]);
    f.destroy();
    await rm(directory, { force: true, recursive: true });
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
      expect(closeRoot).toHaveBeenCalledExactlyOnceWith('closing');
    } finally {
      retired.resolve();
      f.destroy();
    }
  }
);

it('a host whose connection closes without asking closes Main Root borrowers as gone (BST-2004)', async () => {
  const closeRoot = vi.fn(async (): Promise<void> => undefined);
  const f = harness(mainReads(), closeRoot);
  try {
    f.crash();
    await vi.waitFor(() => expect(closeRoot).toHaveBeenCalledExactlyOnceWith('gone'));
    await f.owner.close();
    expect(closeRoot).toHaveBeenCalledOnce();
  } finally {
    f.destroy();
  }
});

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

it('utility loss joins an in-flight Main read’s physical tail before closing borrowed capabilities', async () => {
  const physicalTail = Promise.withResolvers<void>();
  const serverClosed = Promise.withResolvers<void>();
  const release = vi.fn(async () => undefined);
  const read = heldRead(physicalTail.promise);
  const h = harness(mainReads(), release, { diagnostics: read.diagnostics });
  h.server.onClose(() => serverClosed.resolve());
  try {
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
  const h = harness(mainReads(), close, { diagnostics: read.diagnostics });
  const cancellation = new CancellationTokenSource();
  let settled = false;
  try {
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
    click: vi.fn(),
    getPageText: vi.fn(),
    navigate: vi.fn(async () => ({
      ok: true as const,
      title: 'Example',
      url: 'https://example.com/',
    })),
    readPage: vi.fn(),
    selectOption: vi.fn(),
    type: vi.fn(),
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
    // The run's thread rides along: the agent browses among its conversation's pages.
    expect(browser.navigate).toHaveBeenCalledWith({ url: 'https://example.com' }, 'thread');
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
