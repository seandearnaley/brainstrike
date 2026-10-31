// @vitest-environment node
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_HOST_PROTOCOL_VERSION } from '@brainstrike/agent-host/protocol';
import type { HostAttachment } from '@brainstrike/host-lease';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Message, StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node';
import { registerAgentHostClientIpc } from '../agent-host-client-ipc';
import { createAgentHostPrivateClients } from '../agent-host-private-clients';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import { createAllowlistedSenderFrame } from './helpers/desktop-ipc-sender-frame-test-allowlist';
import { invokeDesktopIpcFrom } from './helpers/desktop-ipc-sender-test-helpers';

const APP_WINDOW = 7;
const { ipcMain } = vi.hoisted(() => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('../app-windows', () => ({ isAppWindowSender: (id: number) => id === APP_WINDOW }));
// Node's entangled ports stand in for Electron's: a message posted on one end arrives on
// the other with no process in between. Like MessagePortMain, `message` carries `{ data }`.
vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  const { MessageChannel } = await import('node:worker_threads');
  type NodePort = InstanceType<typeof MessageChannel>['port1'];
  class MessagePortMain extends Emitter {
    readonly #port: NodePort;
    constructor(port: NodePort) {
      super();
      this.#port = port;
      port.on('message', (data: unknown) => this.emit('message', { data }));
      port.on('close', () => this.emit('close'));
    }
    close(): void {
      this.#port.close();
    }
    postMessage(data: unknown): void {
      this.#port.postMessage(data);
    }
    start(): void {
      /* Node ports start with their first listener. */
    }
  }
  class MessageChannelMain {
    readonly port1: MessagePortMain;
    readonly port2: MessagePortMain;
    constructor() {
      const channel = new MessageChannel();
      this.port1 = new MessagePortMain(channel.port1);
      this.port2 = new MessagePortMain(channel.port2);
    }
  }
  return { ipcMain, MessageChannelMain };
});

interface Port extends EventEmitter {
  close(): void;
  postMessage(data: unknown): void;
}

const attachment = { record: { protocolVersion: AGENT_HOST_PROTOCOL_VERSION } } as HostAttachment;

/** The host this app launched; it echoes whatever its private clients send. */
function launchedHost() {
  const exit = Promise.withResolvers<number>();
  const lost = Promise.withResolvers<void>();
  const ports: Port[] = [];
  return {
    exit,
    exited: exit.promise,
    lose: lost.resolve,
    lost: lost.promise,
    ports,
    postClientPort: (port: unknown) => {
      const hostEnd = port as Port;
      hostEnd.on('message', ({ data }: { data: unknown }) => hostEnd.postMessage({ echo: data }));
      ports.push(hostEnd);
    },
    stopForRelaunch: () => exit.promise,
  };
}

/** One renderer document: what Main pushes to its frame, and the page's lifetime events. */
function rendererFrame(senderId = APP_WINDOW) {
  const sender = Object.assign(new EventEmitter(), {
    destroyed: false,
    id: senderId,
    isDestroyed(): boolean {
      return this.destroyed;
    },
  });
  const pushes: { method: string; payload: unknown; port?: Port }[] = [];
  const senderFrame = {
    ...createAllowlistedSenderFrame(),
    postMessage: (
      _channel: string,
      push: { method: string; payload: unknown },
      transfer: unknown[]
    ) => {
      pushes.push({ ...push, ...(transfer[0] ? { port: transfer[0] as Port } : {}) });
    },
  };
  return { event: { sender, senderFrame }, pushes, sender };
}

function setup() {
  const host = launchedHost();
  const clients = createAgentHostPrivateClients();
  clients.attach(host);
  const ipc = registerAgentHostClientIpc(async () => attachment, clients.open);
  const connect = (frame: ReturnType<typeof rendererFrame>) =>
    invokeDesktopIpcFrom(
      ipcMain,
      frame.event,
      DESKTOP_IPC_CHANNELS.agent.hostConnect,
      crypto.randomUUID()
    );
  return { clients, connect, host, ipc };
}

const open: Port[] = [];
afterEach(() => {
  for (const port of open.splice(0)) {
    port.close();
  }
});

describe('a renderer client of the agent host', () => {
  it('talks to the host over its own port and closes the host end when it goes', async () => {
    const { connect, host, ipc } = setup();
    const frame = rendererFrame();

    await expect(connect(frame)).resolves.toEqual({ ok: true, value: undefined });
    const connected = frame.pushes.find(
      (push) => push.method === DESKTOP_IPC_CHANNELS.agent.hostConnected
    );
    const port = connected?.port;
    expect(port).toBeDefined();
    if (!port) {
      return;
    }
    open.push(port, ...host.ports);
    expect(host.ports).toHaveLength(1);

    const reply = once(port, 'message');
    port.postMessage({ jsonrpc: '2.0', method: 'host/ping' });
    await expect(reply).resolves.toEqual([
      { data: { echo: { jsonrpc: '2.0', method: 'host/ping' } } },
    ]);

    // The document goes: Chromium closes its end, and the host's end closes with it.
    const hostEndClosed = once(host.ports[0] as Port, 'close');
    port.close();
    await hostEndClosed;
    await ipc.close();
  });

  it('is told once Main holds the host as gone, and its reconnect reaches the replacement', async () => {
    const { clients, connect, host, ipc } = setup();
    const frame = rendererFrame();
    const requestId = crypto.randomUUID();
    await invokeDesktopIpcFrom(
      ipcMain,
      frame.event,
      DESKTOP_IPC_CHANNELS.agent.hostConnect,
      requestId
    );
    const port = frame.pushes[0]?.port;
    expect(port).toBeDefined();
    if (!port) {
      return;
    }
    open.push(port, ...host.ports);

    // The host dies: the frame's port closes, and Main's lifetime channel closes before
    // Electron reports the exit. Main tells the frame only then.
    const frameEndClosed = once(port, 'close');
    host.ports[0]?.close();
    await frameEndClosed;
    expect(frame.pushes).toHaveLength(1);
    host.lose();
    await vi.waitFor(() =>
      expect(frame.pushes.at(-1)).toEqual({
        method: DESKTOP_IPC_CHANNELS.agent.hostDisconnected,
        payload: { requestId },
      })
    );
    // So the frame's reconnect never reaches the dead host: it waits for the replacement.
    const replacement = launchedHost();
    clients.attach(replacement);
    await expect(connect(frame)).resolves.toEqual({ ok: true, value: undefined });
    expect(host.ports).toHaveLength(1);
    expect(replacement.ports).toHaveLength(1);
    const fresh = frame.pushes.at(-1)?.port;
    open.push(...replacement.ports, ...(fresh ? [fresh] : []));
    await ipc.close();
  });

  it('reaches a host this app did not launch over its public socket', async () => {
    // A CLI `host start`: Main holds no private channel to it, only its socket endpoint.
    const dir = await mkdtemp(join(tmpdir(), 'bs-external-host-'));
    const endpoint =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\bs-external-host-${crypto.randomUUID()}`
        : join(dir, 'host.sock');
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      const writer = new StreamMessageWriter(socket);
      new StreamMessageReader(socket).listen((message) => {
        const id = 'id' in message && typeof message.id === 'number' ? message.id : null;
        void writer.write({ id, jsonrpc: '2.0', result: 'pong' } as Message);
      });
    });
    await new Promise<void>((resolve) => server.listen(endpoint, resolve));
    const external = {
      record: { endpoint, protocolVersion: AGENT_HOST_PROTOCOL_VERSION },
    } as HostAttachment;
    const ipc = registerAgentHostClientIpc(
      async () => external,
      createAgentHostPrivateClients().open
    );
    const frame = rendererFrame();
    const requestId = crypto.randomUUID();
    try {
      await expect(
        invokeDesktopIpcFrom(
          ipcMain,
          frame.event,
          DESKTOP_IPC_CHANNELS.agent.hostConnect,
          requestId
        )
      ).resolves.toEqual({ ok: true, value: undefined });
      const port = frame.pushes[0]?.port;
      expect(port).toBeDefined();
      if (!port) {
        return;
      }
      open.push(port);
      const reply = once(port, 'message');
      port.postMessage({ id: 1, jsonrpc: '2.0', method: 'host/ping' });
      await expect(reply).resolves.toEqual([{ data: { id: 1, jsonrpc: '2.0', result: 'pong' } }]);

      // The external host goes away: the frame's port closes and Main tells it.
      const frameEndClosed = once(port, 'close');
      for (const socket of sockets) {
        socket.destroy();
      }
      await frameEndClosed;
      await vi.waitFor(() =>
        expect(frame.pushes.at(-1)).toEqual({
          method: DESKTOP_IPC_CHANNELS.agent.hostDisconnected,
          payload: { requestId },
        })
      );
    } finally {
      await ipc.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { force: true, recursive: true });
    }
  });

  it('gives a frame that is not an app window no port', async () => {
    const { connect, host, ipc } = setup();
    const frame = rendererFrame(APP_WINDOW + 1);

    await expect(connect(frame)).rejects.toThrow(/app window sender/u);
    expect(host.ports).toHaveLength(0);
    expect(frame.pushes).toHaveLength(0);
    await ipc.close();
  });
});
