import { BUILTIN_SESSION_KEY, createAgentHub } from '@brainstrike/agent-hub';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentHubServerStatus } from '../agent-hub/agent-hub-server-manager';
import { registerAgentHubIpcHandlers } from '../ipc-agent-hub';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';

type InvokeHandler = (event: unknown, ...args: unknown[]) => unknown;

function createFakeIpcMain() {
  const invokeHandlers = new Map<string, InvokeHandler>();
  return {
    handle: vi.fn((channel: string, handler: InvokeHandler) => {
      invokeHandlers.set(channel, handler);
    }),
    invoke: (channel: string, ...args: unknown[]): unknown => {
      const handler = invokeHandlers.get(channel);
      if (!handler) {
        throw new Error(`No handler for ${channel}`);
      }
      return handler({}, ...args);
    },
    invokeHandlers,
    on: vi.fn(),
    removeHandler: vi.fn((channel: string) => {
      invokeHandlers.delete(channel);
    }),
    removeListener: vi.fn(),
  };
}

function createFakeManager() {
  let statusListener: ((status: AgentHubServerStatus) => void) | null = null;
  const status: AgentHubServerStatus = {
    connectionCount: 0,
    error: null,
    state: 'stopped',
    url: null,
  };
  return {
    applyConfig: vi.fn(() => Promise.resolve(status)),
    emitStatus: (next: AgentHubServerStatus) => statusListener?.(next),
    getConfig: vi.fn(() => ({})),
    getStatus: vi.fn(() => status),
    onStatusChange: vi.fn((cb: (s: AgentHubServerStatus) => void) => {
      statusListener = cb;
      return () => {
        statusListener = null;
      };
    }),
    start: vi.fn(() => Promise.resolve(status)),
    stop: vi.fn(() => Promise.resolve()),
  };
}

function createFakeTarget() {
  return { isDestroyed: vi.fn(() => false), send: vi.fn() };
}

describe('registerAgentHubIpcHandlers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    const hub = createAgentHub();
    const ipcMain = createFakeIpcMain();
    const manager = createFakeManager();
    const target = createFakeTarget();
    const dispose = registerAgentHubIpcHandlers({
      getBroadcastTargets: () => [target],
      hub,
      // biome-ignore lint/suspicious/noExplicitAny: structural fake for tests
      ipcMain: ipcMain as any,
      // biome-ignore lint/suspicious/noExplicitAny: structural fake for tests
      manager: manager as any,
    });
    return { dispose, hub, ipcMain, manager, target };
  }

  it('registers all agent hub invoke channels', () => {
    const { dispose, ipcMain } = setup();
    const channels = DESKTOP_IPC_CHANNELS.agentHub;
    for (const channel of [
      channels.applyConfig,
      channels.getSnapshot,
      channels.getStatus,
      channels.postMessage,
      channels.start,
      channels.stop,
    ]) {
      expect(ipcMain.invokeHandlers.has(channel)).toBe(true);
    }
    dispose();
    expect(ipcMain.invokeHandlers.size).toBe(0);
  });

  it('post-message posts as the builtin participant', async () => {
    const { dispose, hub, ipcMain } = setup();
    await ipcMain.invoke(DESKTOP_IPC_CHANNELS.agentHub.postMessage, { text: 'hi from sean' });
    const snapshot = hub.getSnapshot();
    expect(snapshot.recentMessages).toHaveLength(1);
    expect(snapshot.recentMessages[0]?.fromName).toBe('brainstrike');
    expect(hub.getAgentBySessionKey(BUILTIN_SESSION_KEY)?.tokensSent).toBeGreaterThan(0);
    dispose();
  });

  it('coalesces hub events into a single snapshot broadcast', () => {
    const { dispose, hub, target } = setup();
    hub.registerAgent({ name: 'a', sessionKey: 's1' });
    hub.postMessage({ sessionKey: 's1', text: 'one' });
    hub.postMessage({ sessionKey: 's1', text: 'two' });
    expect(target.send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(150);
    const snapshotCalls = target.send.mock.calls.filter(
      ([channel]) => channel === DESKTOP_IPC_CHANNELS.agentHub.snapshotEvent
    );
    expect(snapshotCalls).toHaveLength(1);
    const payload = snapshotCalls[0]?.[1] as { totalMessages: number };
    expect(payload.totalMessages).toBe(2);
    dispose();
  });

  it('forwards manager status changes immediately', () => {
    const { dispose, manager, target } = setup();
    manager.emitStatus({ connectionCount: 3, error: null, state: 'running', url: 'http://x' });
    const statusCalls = target.send.mock.calls.filter(
      ([channel]) => channel === DESKTOP_IPC_CHANNELS.agentHub.statusEvent
    );
    expect(statusCalls).toHaveLength(1);
    expect(statusCalls[0]?.[1]).toMatchObject({ connectionCount: 3, state: 'running' });
    dispose();
  });

  it('stops broadcasting after dispose', () => {
    const { dispose, hub, target } = setup();
    dispose();
    hub.registerAgent({ name: 'late', sessionKey: 's9' });
    vi.advanceTimersByTime(500);
    expect(target.send).not.toHaveBeenCalled();
  });
});
