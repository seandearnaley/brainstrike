import type { McpTaskPresentation } from '@brainstrike/assistant-contract';
import type { McpDesktopTaskHostPort } from '@brainstrike/host-capabilities/mcp/task-host';
import type { BrowserWindow } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachMcpTaskBridge } from '../../mcp/task-bridge';
import { DESKTOP_PRELOAD_IPC_CHANNELS } from '../../platform/desktop-ipc-channels';
import type { DesktopIpcInvokeHandler } from '../../platform/desktop-ipc-registry';

const { getTrackedWindowsByRoleMock } = vi.hoisted(() => ({
  getTrackedWindowsByRoleMock: vi.fn(() => [] as unknown[]),
}));

vi.mock('../../window-role', () => ({
  getTrackedWindowsByRole: getTrackedWindowsByRoleMock,
}));

const presentation: McpTaskPresentation = {
  canCancel: true,
  createdAt: '2026-09-01T05:00:00.000Z',
  handle: {
    authorityEpoch: '01994f2a-2f3b-7c1d-8f6e-1c2d3e4f5a6b',
    principalId: 'none',
    resource: 'https://tasks.example.test/mcp',
    serverId: 'team.tasks.prod',
    taskId: 'task-1',
  },
  history: [{ at: '2026-09-01T05:00:00.000Z', status: 'working' }],
  omittedHistoryEntries: 0,
  recovery: 'live',
  status: 'working',
  statusMessage: 'Queued',
  updatedAt: '2026-09-01T05:00:00.000Z',
};
type Handler = DesktopIpcInvokeHandler<readonly [unknown], unknown>;

function createWindow(destroyed = false) {
  return { isDestroyed: () => destroyed, webContents: { send: vi.fn() } };
}

function createHarness() {
  let listener: ((task: McpTaskPresentation) => void) | undefined;
  const unsubscribe = vi.fn();
  const taskHost: Pick<McpDesktopTaskHostPort, 'act' | 'list' | 'subscribe'> = {
    act: vi.fn(async () => ({ ok: true as const, task: presentation })),
    list: vi.fn(() => ({ tasks: [presentation] })),
    subscribe: vi.fn((next: (task: McpTaskPresentation) => void) => {
      listener = next;
      return unsubscribe;
    }),
  };
  const handlers = new Map<string, Handler>();
  const registry = {
    registerAuthorizedInvoke: vi.fn(
      (_domain: string, channel: string, _policy: unknown, handler: unknown) => {
        handlers.set(channel, handler as Handler);
      }
    ),
  };
  const invoke = (channel: string, payload?: unknown) => {
    const handler = handlers.get(channel);
    if (!handler) {
      throw new Error(`${channel} was not registered`);
    }
    return Promise.resolve().then(() => handler({} as Parameters<Handler>[0], payload));
  };
  return {
    emit: (task: McpTaskPresentation) => listener?.(task),
    invoke,
    registry,
    taskHost,
    unsubscribe,
  };
}

afterEach(() => {
  getTrackedWindowsByRoleMock.mockReturnValue([]);
  vi.clearAllMocks();
});

describe('attachMcpTaskBridge', () => {
  it('registers visible-ui-only channels, broadcasts status changes, and detaches', async () => {
    const live = createWindow();
    const destroyed = createWindow(true);
    getTrackedWindowsByRoleMock.mockReturnValue([live, destroyed] as unknown as BrowserWindow[]);
    const harness = createHarness();
    const detach = attachMcpTaskBridge({ taskHost: harness.taskHost }, harness.registry);
    for (const channel of [
      DESKTOP_PRELOAD_IPC_CHANNELS.mcp.taskAct,
      DESKTOP_PRELOAD_IPC_CHANNELS.mcp.taskList,
    ]) {
      expect(harness.registry.registerAuthorizedInvoke).toHaveBeenCalledWith(
        'mcp',
        channel,
        { roles: ['visible-ui'] },
        expect.any(Function)
      );
    }
    harness.emit(presentation);
    expect(getTrackedWindowsByRoleMock).toHaveBeenCalledWith('visible-ui');
    expect(live.webContents.send).toHaveBeenCalledWith(
      DESKTOP_PRELOAD_IPC_CHANNELS.mcp.taskStatusChanged,
      { task: presentation }
    );
    expect(destroyed.webContents.send).not.toHaveBeenCalled();

    await expect(harness.invoke(DESKTOP_PRELOAD_IPC_CHANNELS.mcp.taskList)).resolves.toEqual({
      tasks: [presentation],
    });
    const request = { action: 'cancel', handle: presentation.handle };
    await expect(
      harness.invoke(DESKTOP_PRELOAD_IPC_CHANNELS.mcp.taskAct, request)
    ).resolves.toEqual({ ok: true, task: presentation });
    expect(harness.taskHost.act).toHaveBeenCalledWith(request);
    await expect(
      harness.invoke(DESKTOP_PRELOAD_IPC_CHANNELS.mcp.taskAct, { action: 'explode' })
    ).rejects.toMatchObject({ code: 'mcp-task-action-malformed' });
    expect(harness.taskHost.act).toHaveBeenCalledTimes(1);

    detach();
    expect(harness.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
