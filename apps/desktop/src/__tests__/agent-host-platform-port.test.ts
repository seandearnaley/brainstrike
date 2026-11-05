// @vitest-environment node

import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import type { CredentialCipher } from '@brainstrike/agent-host/credential-contract';
import { createHostCredentials } from '@brainstrike/host-capabilities/credentials';
import { expect, it, vi } from 'vitest';
import { CancellationTokenSource } from 'vscode-jsonrpc/node';
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
  admission: DesktopAdmissionReads,
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
  const f = harness(mainReads(), undefined, mainCipher);
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

it('utility loss joins an in-flight Main read’s physical tail before the platform closes', async () => {
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
    expect(closed).toBe(true);
  } finally {
    physicalTail.resolve();
    h.destroy();
    await h.owner.close();
  }
});

it('cancellation and close wait for an in-flight Main read’s physical tail before the platform closes', async () => {
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
    expect(settled).toBe(true);
  } finally {
    joined.resolve();
    cancellation.dispose();
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
