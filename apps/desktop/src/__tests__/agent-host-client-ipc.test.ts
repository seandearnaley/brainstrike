// @vitest-environment node
import { EventEmitter, once } from 'node:events';
import type { MessagePort } from 'node:worker_threads';
import { AGENT_HOST_PROTOCOL_VERSION } from '@brainstrike/agent-host/protocol';
import type { HostAttachment } from '@brainstrike/host-lease';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerAgentHostClientIpc } from '../agent-host-client-ipc';
import { createAgentHostPrivateClients } from '../agent-host-private-clients';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import { createAllowlistedSenderFrame } from './helpers/desktop-ipc-sender-frame-test-allowlist';
import { invokeDesktopIpcFrom } from './helpers/desktop-ipc-sender-test-helpers';

const APP_WINDOW = 7;
const { ipcMain } = vi.hoisted(() => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('../app-windows', () => ({ isAppWindowSender: (id: number) => id === APP_WINDOW }));
// Node's entangled ports stand in for Electron's: a message posted on one end
// arrives on the other with no process in between.
vi.mock('electron', async () => ({
  ipcMain,
  MessageChannelMain: (await import('node:worker_threads')).MessageChannel,
}));

const attachment = { record: { protocolVersion: AGENT_HOST_PROTOCOL_VERSION } } as HostAttachment;

/** The host this app launched; it echoes whatever its private clients send. */
function launchedHost() {
  const exit = Promise.withResolvers<number>();
  const ports: MessagePort[] = [];
  return {
    exit,
    exited: exit.promise,
    ports,
    postClientPort: (port: unknown) => {
      const hostEnd = port as MessagePort;
      hostEnd.on('message', (data: unknown) => hostEnd.postMessage({ echo: data }));
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
  const pushes: { method: string; payload: unknown; port?: MessagePort }[] = [];
  const senderFrame = {
    ...createAllowlistedSenderFrame(),
    postMessage: (
      _channel: string,
      push: { method: string; payload: unknown },
      transfer: unknown[]
    ) => {
      pushes.push({ ...push, ...(transfer[0] ? { port: transfer[0] as MessagePort } : {}) });
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

const open: MessagePort[] = [];
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
    await expect(reply).resolves.toEqual([{ echo: { jsonrpc: '2.0', method: 'host/ping' } }]);

    // The document goes: Chromium closes its end, and the host's end closes with it.
    const hostEndClosed = once(host.ports[0] as MessagePort, 'close');
    port.close();
    await hostEndClosed;
    await ipc.close();
  });

  it('is told the host exited, so it connects again and gets a fresh port', async () => {
    const { clients, connect, host, ipc } = setup();
    const frame = rendererFrame();
    const connectedRequest = crypto.randomUUID();
    await invokeDesktopIpcFrom(
      ipcMain,
      frame.event,
      DESKTOP_IPC_CHANNELS.agent.hostConnect,
      connectedRequest
    );
    open.push(...host.ports, ...frame.pushes.flatMap((push) => (push.port ? [push.port] : [])));

    host.exit.resolve(0);
    await vi.waitFor(() =>
      expect(frame.pushes.at(-1)).toEqual({
        method: DESKTOP_IPC_CHANNELS.agent.hostDisconnected,
        payload: { requestId: connectedRequest },
      })
    );
    // The profile's next acquisition launches a replacement, which receives the new client.
    const replacement = launchedHost();
    clients.attach(replacement);
    await expect(connect(frame)).resolves.toEqual({ ok: true, value: undefined });
    const fresh = frame.pushes.at(-1)?.port;
    expect(fresh).toBeDefined();
    expect(replacement.ports).toHaveLength(1);
    open.push(...replacement.ports, ...(fresh ? [fresh] : []));
    await ipc.close();
  });

  it('a reloaded document is not told about its previous connection', async () => {
    const { connect, host, ipc } = setup();
    const frame = rendererFrame();
    await connect(frame);
    open.push(...host.ports, ...frame.pushes.flatMap((push) => (push.port ? [push.port] : [])));

    frame.sender.emit('did-navigate');
    host.exit.resolve(0);
    await host.exited;
    await Promise.resolve();
    expect(frame.pushes.map((push) => push.method)).toEqual([
      DESKTOP_IPC_CHANNELS.agent.hostConnected,
    ]);
    await ipc.close();
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
