// @vitest-environment node

import { EventEmitter } from 'node:events';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { expect, it, vi } from 'vitest';
import { CancellationTokenSource } from 'vscode-jsonrpc/node';
import {
  mainPlatformConnection,
  type PlatformMessagePort,
} from '../agent-host-platform/connection';
import {
  type DesktopPlatformCapabilities,
  type MainAdmissionReads,
  serveDesktopPlatform,
} from '../agent-host-platform/main-platform';
import { createDesktopMcpPlatformCapabilities } from '../mcp/desktop-host-platform';
import { MainMcpHostControl } from '../mcp/main-host-control';
import { mainReads } from './fixtures/desktop-admission-reads';

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
  admission: MainAdmissionReads,
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

it('acknowledges capability binding through the private platform readiness request', async () => {
  const f = harness(mainReads());
  try {
    await expect(f.client.sendRequest('platform/ready', {})).resolves.toBeNull();
    await expect(f.client.sendRequest('platform/ready', { partial: true })).rejects.toThrow();
  } finally {
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

it('utility loss joins an in-flight Main read’s physical tail before Main’s close settles', async () => {
  const physicalTail = Promise.withResolvers<void>();
  const serverClosed = Promise.withResolvers<void>();
  const read = heldRead(physicalTail.promise);
  const h = harness(mainReads(), { diagnostics: read.diagnostics });
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
    physicalTail.resolve();
    await closing;
    await expect(reading).rejects.toThrow();
  } finally {
    physicalTail.resolve();
    h.destroy();
    await h.owner.close();
  }
});

it('cancellation and close wait for an in-flight Main read’s physical tail', async () => {
  const joined = Promise.withResolvers<void>();
  const read = heldRead(joined.promise);
  const h = harness(mainReads(), { diagnostics: read.diagnostics });
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
    joined.resolve();
    // This read does not observe its signal, so it settles with its result.
    await expect(reading).resolves.toEqual([]);
    await closing;
  } finally {
    joined.resolve();
    cancellation.dispose();
    h.destroy();
  }
});

it('serves the query embedding to the host', async () => {
  const queryEmbedding = vi.fn(async (_payload: unknown, signal: AbortSignal) => {
    expect(signal).toBeInstanceOf(AbortSignal);
    return [0.5, 0.25];
  });
  const unused = () => Promise.reject(new Error('This case only queries embeddings'));
  const h = harness(mainReads(), undefined, {
    destroyAndRestart: unused,
    documentEmbeddings: unused,
    // Main's one embedding host relay serves the retrieval tools' queries too.
    queryEmbedding: async (payload, options) =>
      await queryEmbedding(payload, options?.signal ?? new AbortController().signal),
    stop: unused,
  });
  try {
    const payload = { dimensions: 2, modelId: 'model', modelKey: 'local::model', query: 'marker' };
    await expect(
      h.client.sendRequest('platform/embedding/query', { request: payload })
    ).resolves.toEqual({ ok: true, result: [0.5, 0.25] });
    expect(queryEmbedding).toHaveBeenCalledWith(payload, expect.any(AbortSignal));
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
  const h = harness(mainReads(), { browser });
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
  const h = harness(mainReads(), { diagnostics });
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
