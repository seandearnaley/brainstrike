// @vitest-environment node
import { EventEmitter } from 'node:events';
import { AGENT_HOST_PROTOCOL_VERSION } from '@brainstrike/agent-host/protocol';
import type { HostAttachment } from '@brainstrike/host-lease';
import type { IpcMainInvokeEvent } from 'electron';
import { beforeEach, expect, it, vi } from 'vitest';
import { registerAgentHostClientIpc } from '../../agent-host-client-ipc';
import {
  configureDesktopRendererTarget,
  createDesktopRendererTarget,
} from '../../desktop-renderer-target';
import { assignWindowRole } from '../../window-role';

const fixture = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>(),
  relay: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>
    ) => fixture.handlers.set(channel, handler),
    removeHandler: (channel: string) => fixture.handlers.delete(channel),
  },
}));
vi.mock('../../agent-host-port-relay', () => ({
  openAgentHostChildRelay: fixture.relay,
  openAgentHostPortRelay: fixture.relay,
}));

const attachment = {
  kind: 'owned',
  record: {
    endpoint: '/tmp/recorded-host-fixture',
    hostVersion: '0.1.0',
    pid: process.pid,
    protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
    start: 'synthetic client fixture',
    token: 'a'.repeat(64),
  },
} as unknown as HostAttachment;

beforeEach(() => {
  fixture.handlers.clear();
  fixture.relay.mockReset();
  fixture.relay.mockImplementation(() => {
    const closed = Promise.withResolvers<void>();
    return {
      close: vi.fn(async () => closed.resolve()),
      closed: closed.promise,
      port: { close: vi.fn() },
    };
  });
  configureDesktopRendererTarget(
    createDesktopRendererTarget({
      builtRendererPath: '/disposable/index.html',
      devRendererUrl: 'http://localhost:38181',
      launchMode: 'built',
    })
  );
});

function sender() {
  const emitter = new EventEmitter();
  const webContents = Object.assign(emitter, { id: 191, isDestroyed: () => false });
  assignWindowRole({ isDestroyed: () => false, once: vi.fn(), webContents } as never, 'visible-ui');
  const frame = { postMessage: vi.fn(), url: 'file:///disposable/index.html' };
  const event = { sender: webContents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  return { event, frame, webContents };
}

it.each(['did-navigate', 'render-process-gone', 'destroyed', 'shutdown'])(
  'retires a pending attach on %s before its reset idle wait can acquire a profile',
  async (reason) => {
    const idle = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const acquire = vi.fn(async () => attachment);
    const bridge = registerAgentHostClientIpc(
      async (_options, signal?: AbortSignal) => {
        entered.resolve();
        await idle.promise;
        signal?.throwIfAborted();
        return acquire();
      },
      () => undefined
    );
    const source = sender();
    const invoke = fixture.handlers.get('agent:host-connect');
    if (!invoke) {
      throw new Error('Missing host-connect handler');
    }
    const pending = invoke(source.event, crypto.randomUUID()).catch((error: unknown) => error);
    await entered.promise;
    const closing = reason === 'shutdown' ? bridge.close() : undefined;
    if (reason !== 'shutdown') {
      source.webContents.emit(reason);
    }
    idle.resolve();
    const result = await pending;
    await closing;
    await bridge.close();
    expect(acquire).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      error: { category: 'availability', code: 'agent.attachment-retired', kind: 'refusal' },
      ok: false,
    });
    expect(fixture.relay).not.toHaveBeenCalled();
    expect(source.frame.postMessage).not.toHaveBeenCalled();
    expect(source.webContents.eventNames()).toEqual([]);
  }
);

it('retains an independent acquisition failure when the frame retires during acquisition', async () => {
  const acquisition = Promise.withResolvers<HostAttachment>();
  const failure = new Error('independent host acquisition failure');
  const bridge = registerAgentHostClientIpc(
    () => acquisition.promise,
    () => undefined
  );
  const source = sender();
  const invoke = fixture.handlers.get('agent:host-connect');
  if (!invoke) {
    throw new Error('Missing host-connect handler');
  }
  const pending = invoke(source.event, crypto.randomUUID());
  const closing = bridge.close().catch((error: unknown) => error);
  acquisition.reject(failure);
  expect(await pending).toMatchObject({
    error: { code: 'boundary.internal', kind: 'fault' },
    ok: false,
  });
  const failed = await closing;
  expect(failed).toBeInstanceOf(AggregateError);
  expect((failed as AggregateError).errors).toEqual([failure]);
  expect(fixture.relay).not.toHaveBeenCalled();
});

it('joins a frame-retired relay physical exit and preserves its independent close failure', async () => {
  const exited = Promise.withResolvers<void>();
  const closeFailed = Promise.withResolvers<void>();
  const failure = new Error('independent relay close failure');
  const close = vi.fn(() => closeFailed.promise);
  fixture.relay.mockReturnValue({ close, closed: exited.promise, port: { close: vi.fn() } });
  const bridge = registerAgentHostClientIpc(
    async () => attachment,
    () => undefined
  );
  const source = sender();
  const invoke = fixture.handlers.get('agent:host-connect');
  if (!invoke) {
    throw new Error('Missing host-connect handler');
  }
  await invoke(source.event, crypto.randomUUID());
  source.webContents.emit('did-navigate');
  expect(close).toHaveBeenCalledTimes(1);
  exited.resolve();
  closeFailed.reject(failure);
  await Promise.resolve();
  const result = await bridge.close().catch((error: unknown) => error);
  expect(result).toBeInstanceOf(AggregateError);
  expect((result as AggregateError).errors).toEqual([failure]);
  expect(close).toHaveBeenCalledTimes(1);
});
