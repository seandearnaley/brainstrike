import {
  type McpHostServerSnapshot,
  parseConfiguredMcpServerId,
} from '@brainstrike/assistant-contract';
import { McpElicitationPresenterAuthority } from '@brainstrike/host-capabilities/mcp/elicitation-presenter';
import type { ElicitRequest } from '@modelcontextprotocol/client';
import type { BrowserWindow } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachMcpElicitationBridge } from '../../mcp/elicitation-bridge';
import { DESKTOP_PRELOAD_IPC_CHANNELS } from '../../platform/desktop-ipc-channels';
import type { DesktopIpcInvokeHandler } from '../../platform/desktop-ipc-registry';

const { getTrackedWindowsByRoleMock } = vi.hoisted(() => ({
  getTrackedWindowsByRoleMock: vi.fn(() => [] as unknown[]),
}));

// Consent payloads reach tracked visible-UI windows only; the bridge never
// enumerates BrowserWindow.getAllWindows().
vi.mock('../../window-role', () => ({
  getTrackedWindowsByRole: getTrackedWindowsByRoleMock,
}));

const SERVER_ID = parseConfiguredMcpServerId('team.linear.prod');
const connectedServer = (): McpHostServerSnapshot => ({
  configuredProtocol: '2026-07-28',
  configuredServerId: SERVER_ID,
  generation: 7,
  negotiated: {
    era: 'modern',
    revision: '2026-07-28',
    serverIdentity: { name: 'Linear MCP', title: 'Linear', version: '2.0.0' },
  },
  state: 'connected',
  transport: 'streamable-http',
});
const formRequest = {
  method: 'elicitation/create',
  params: {
    message: 'Choose a workspace',
    mode: 'form',
    requestedSchema: {
      properties: { workspace: { type: 'string' } },
      required: ['workspace'],
      type: 'object',
    },
  },
} satisfies ElicitRequest;
const context = (requestId: string) => ({
  requestId,
  serverName: SERVER_ID,
  signal: new AbortController().signal,
});
type SettleHandler = DesktopIpcInvokeHandler<readonly [unknown], void>;

function createWindow(destroyed = false) {
  return {
    isDestroyed: () => destroyed,
    webContents: { send: vi.fn() },
  };
}

function createHarness() {
  let sequence = 1;
  const authority = new McpElicitationPresenterAuthority({
    createPresentationId: () => `presentation-${sequence++}`,
    openExternal: vi.fn(async () => undefined),
    resolveServer: () => connectedServer(),
  });
  const handlers = new Map<string, SettleHandler>();
  const invokeEvent = {} as Parameters<SettleHandler>[0];
  const registry = {
    registerAuthorizedInvoke: vi.fn(
      (_domain: string, channel: string, _policy: unknown, handler: unknown) => {
        handlers.set(channel, handler as SettleHandler);
      }
    ),
  };
  const settleHandler = (): ((settlement: unknown) => Promise<void>) => {
    const handler = handlers.get(DESKTOP_PRELOAD_IPC_CHANNELS.mcp.elicitationSettle);
    if (!handler) {
      throw new Error('settle handler was not registered');
    }
    // ipcMain.handle converts synchronous throws into invoke rejections.
    return (settlement) => Promise.resolve().then(() => handler(invokeEvent, settlement));
  };
  const present = (requestId: string) =>
    authority.runWithOperation(
      { configuredServerId: SERVER_ID, toolName: 'search_issues', type: 'tools/call' },
      () => authority.presenter.presentForm(formRequest, context(requestId))
    );
  const runtime = { elicitationPresenter: authority };
  return { authority, handlers, present, registry, runtime, settleHandler };
}

afterEach(() => {
  getTrackedWindowsByRoleMock.mockReturnValue([]);
  vi.clearAllMocks();
});

describe('attachMcpElicitationBridge', () => {
  it('broadcasts presentations to every live window and settles through the invoke channel', async () => {
    const live = createWindow();
    const other = createWindow();
    const destroyed = createWindow(true);
    getTrackedWindowsByRoleMock.mockReturnValue([
      live,
      destroyed,
      other,
    ] as unknown as BrowserWindow[]);
    const harness = createHarness();
    const detach = attachMcpElicitationBridge(harness.runtime, harness.registry);
    // Settlements accept content or authorize a URL, so only visible UI may
    // send them; the registry enforces the role before the payload is parsed.
    expect(harness.registry.registerAuthorizedInvoke).toHaveBeenCalledWith(
      'mcp',
      DESKTOP_PRELOAD_IPC_CHANNELS.mcp.elicitationSettle,
      { roles: ['visible-ui'] },
      expect.any(Function)
    );

    const pending = harness.present('elicitation-1');
    expect(getTrackedWindowsByRoleMock).toHaveBeenCalledWith('visible-ui');
    for (const window of [live, other]) {
      expect(window.webContents.send).toHaveBeenCalledWith(
        DESKTOP_PRELOAD_IPC_CHANNELS.mcp.elicitationRequested,
        expect.objectContaining({
          id: 'presentation-1',
          message: 'Choose a workspace',
          mode: 'form',
          provenance: expect.objectContaining({
            configuredServerId: SERVER_ID,
            generation: 7,
            requestId: 'elicitation-1',
            serverIdentity: { name: 'Linear MCP', title: 'Linear', version: '2.0.0' },
          }),
        })
      );
    }
    expect(destroyed.webContents.send).not.toHaveBeenCalled();
    expect(live.webContents.send.mock.calls[0]?.[1]).toEqual(
      other.webContents.send.mock.calls[0]?.[1]
    );

    await harness.settleHandler()({
      action: 'accept',
      configuredServerId: SERVER_ID,
      content: { workspace: 'Engineering' },
      generation: 7,
      id: 'presentation-1',
      requestId: 'elicitation-1',
    });
    await expect(pending).resolves.toEqual({
      action: 'accept',
      content: { workspace: 'Engineering' },
    });
    expect(live.webContents.send).toHaveBeenCalledWith(
      DESKTOP_PRELOAD_IPC_CHANNELS.mcp.elicitationRetired,
      { code: 'mcp-elicitation-already-settled', id: 'presentation-1' }
    );
    detach();
  });

  it('rejects malformed settlements before they reach the presenter and maps presenter codes', async () => {
    const harness = createHarness();
    const settleSpy = vi.spyOn(harness.authority, 'settle');
    const detach = attachMcpElicitationBridge(harness.runtime, harness.registry);
    const settle = harness.settleHandler();

    await expect(
      settle({
        action: 'decline',
        configuredServerId: SERVER_ID,
        content: {},
        generation: 7,
        id: 'presentation-1',
        requestId: 'elicitation-1',
      })
    ).rejects.toMatchObject({ code: 'mcp-elicitation-settlement-malformed' });
    await expect(settle('nope')).rejects.toMatchObject({
      code: 'mcp-elicitation-settlement-malformed',
    });
    expect(settleSpy).not.toHaveBeenCalled();

    const pending = harness.present('elicitation-1');
    await expect(
      settle({
        action: 'cancel',
        configuredServerId: SERVER_ID,
        generation: 8,
        id: 'presentation-1',
        requestId: 'elicitation-1',
      })
    ).rejects.toMatchObject({
      code: 'mcp-elicitation-stale-authority',
      message: 'MCP elicitation settlement failed: mcp-elicitation-stale-authority',
    });
    await settle({
      action: 'cancel',
      configuredServerId: SERVER_ID,
      generation: 7,
      id: 'presentation-1',
      requestId: 'elicitation-1',
    });
    await expect(pending).resolves.toEqual({ action: 'cancel' });
    await expect(
      settle({
        action: 'cancel',
        configuredServerId: SERVER_ID,
        generation: 7,
        id: 'presentation-1',
        requestId: 'elicitation-1',
      })
    ).rejects.toMatchObject({ code: 'mcp-elicitation-already-settled' });
    detach();
  });

  it('attaches exactly once per presenter', () => {
    const harness = createHarness();
    const detach = attachMcpElicitationBridge(harness.runtime, harness.registry);
    expect(() => attachMcpElicitationBridge(harness.runtime, harness.registry)).toThrowError(
      expect.objectContaining({ code: 'mcp-elicitation-presenter-unavailable' })
    );
    detach();
    const reattached = attachMcpElicitationBridge(harness.runtime, harness.registry);
    reattached();
  });

  it('retires pending presentations with presenter-unavailable when unregistered and pushes retirement events', async () => {
    const window = createWindow();
    getTrackedWindowsByRoleMock.mockReturnValue([window] as unknown as BrowserWindow[]);
    const harness = createHarness();
    const detach = attachMcpElicitationBridge(harness.runtime, harness.registry);
    const pending = harness.present('elicitation-1');
    const rejection = expect(pending).rejects.toMatchObject({
      code: 'mcp-elicitation-presenter-unavailable',
    });
    detach();
    await rejection;
    expect(window.webContents.send).toHaveBeenLastCalledWith(
      DESKTOP_PRELOAD_IPC_CHANNELS.mcp.elicitationRetired,
      { code: 'mcp-elicitation-presenter-unavailable', id: 'presentation-1' }
    );

    const sendsBeforeDetachedRetirement = window.webContents.send.mock.calls.length;
    await expect(
      harness.authority.presenter.presentForm(formRequest, context('elicitation-2'))
    ).rejects.toMatchObject({ code: 'mcp-elicitation-presenter-unavailable' });
    expect(window.webContents.send).toHaveBeenCalledTimes(sendsBeforeDetachedRetirement);

    const reattached = attachMcpElicitationBridge(harness.runtime, harness.registry);
    const retired = harness.present('elicitation-3');
    const retiredRejection = expect(retired).rejects.toMatchObject({
      code: 'mcp-elicitation-authority-retired',
    });
    harness.authority.retireServer(SERVER_ID, 7);
    await retiredRejection;
    expect(window.webContents.send).toHaveBeenLastCalledWith(
      DESKTOP_PRELOAD_IPC_CHANNELS.mcp.elicitationRetired,
      { code: 'mcp-elicitation-stale-authority', id: 'presentation-2' }
    );
    reattached();
  });
});
