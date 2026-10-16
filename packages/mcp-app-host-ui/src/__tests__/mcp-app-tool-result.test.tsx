import '@testing-library/jest-dom/vitest';
import { type ThreadMessageLike, useExternalStoreRuntime } from '@assistant-ui/react';
import type { McpAppBridge, McpAppOrigin } from '@brainstrike/assistant-contract';
import { createMcpAppToolInvocationResult } from '@brainstrike/assistant-contract';
import { AssistantConversationPanel, ToolResultRendererProvider } from '@brainstrike/assistant-ui';
import { TooltipProvider } from '@brainstrike/ui';
import { InMemoryTransport, parseJSONRPCMessage } from '@modelcontextprotocol/client';
import { App } from '@modelcontextprotocol/ext-apps';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createContext, type ReactElement, StrictMode, use } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { McpAppBridgeProvider } from '../mcp-app-bridge-context';
import {
  type McpAppMountedSession,
  type McpAppRuntimePorts,
  McpAppToolResult,
} from '../mcp-app-tool-result';
import { mcpAppToolResultRenderer } from '../mcp-app-tool-result-renderer';
import { McpAppsEnablementProvider } from '../mcp-apps-enablement-context';

const APP: McpAppOrigin = {
  mimeType: 'text/html;profile=mcp-app',
  resourceUri: 'ui://linear/issue-editor',
  serverId: 'linear',
  toolName: 'create_issue',
};

const APP_DOCUMENT = '<!doctype html><title>Issue editor</title><p>editor</p>';

const INITIALIZE = Object.freeze({
  id: 'initialize',
  jsonrpc: '2.0',
  method: 'ui/initialize',
  params: {
    appCapabilities: {},
    appInfo: { name: 'Linear', version: '1.0.0' },
    protocolVersion: '2026-01-26',
  },
});

const INITIALIZED = Object.freeze({
  jsonrpc: '2.0',
  method: 'ui/notifications/initialized',
  params: {},
});

interface TestMessageEvent {
  readonly data: unknown;
  readonly origin: string;
  readonly source: unknown;
}

class TestMessageTarget {
  readonly listeners = new Set<(event: TestMessageEvent) => void>();

  addEventListener(_type: 'message', listener: (event: TestMessageEvent) => void): void {
    this.listeners.add(listener);
  }

  dispatch(source: unknown, data: unknown): void {
    for (const listener of [...this.listeners]) {
      listener({ data, origin: 'null', source });
    }
  }

  removeEventListener(_type: 'message', listener: (event: TestMessageEvent) => void): void {
    this.listeners.delete(listener);
  }
}

class TestFrame {
  readonly sent: unknown[] = [];
  onMessage?: (message: unknown) => void;

  postMessage(message: unknown): void {
    this.sent.push(message);
    this.onMessage?.(message);
  }
}

interface Harness {
  readonly bridge: McpAppBridge;
  readonly created: string[];
  readonly execute: ReturnType<typeof vi.fn>;
  readonly frame: TestFrame;
  readonly ports: McpAppRuntimePorts;
  readonly prepare: ReturnType<typeof vi.fn>;
  readonly release: ReturnType<typeof vi.fn>;
  readonly revoked: string[];
  readonly target: TestMessageTarget;
}

function harness(decision: 'allow' | 'ask' = 'ask'): Harness {
  const created: string[] = [];
  const revoked: string[] = [];
  const frame = new TestFrame();
  const target = new TestMessageTarget();
  const prepare = vi.fn(async () => ({ decision, riskCategory: 'execute' as const }));
  const execute = vi.fn(async () => ({ result: { content: [{ text: 'done', type: 'text' }] } }));
  const release = vi.fn(async () => undefined);
  let sequence = 0;
  const bridge: McpAppBridge = {
    execute: execute as unknown as McpAppBridge['execute'],
    prepare: prepare as unknown as McpAppBridge['prepare'],
    // The host serves each shell from its own brainstrike-mcp-app: origin;
    // `created`/`revoked` record the URLs it handed out and took back.
    prepareShell: vi.fn(async (request) => {
      expect(request.document).toContain('MCP App sandbox');
      expect(request.contentSecurityPolicy).toContain("default-src 'none'");
      expect(request.permissionsPolicy).toContain('camera=()');
      sequence += 1;
      const token = sequence.toString(16).padStart(32, '0');
      const shellUrl = `brainstrike-mcp-app://${token}/`;
      created.push(shellUrl);
      return { shellUrl, token };
    }),
    readResource: vi.fn(async () => APP_DOCUMENT),
    release: release as unknown as McpAppBridge['release'],
    releaseShell: vi.fn(async ({ token }) => {
      revoked.push(`brainstrike-mcp-app://${token}/`);
    }),
  };
  return {
    bridge,
    created,
    execute,
    frame,
    ports: { eventTarget: target, resolveFrameSource: () => frame },
    prepare,
    release,
    revoked,
    target,
  };
}

const APP_RESULT = createMcpAppToolInvocationResult(APP, { content: [] });

const TOOL_CALL = {
  args: {},
  argsText: '{}',
  result: APP_RESULT,
  status: { type: 'complete' as const },
  threadId: 'thread-a',
  toolCallId: 'call-1',
  toolName: 'create_issue',
} as unknown as Parameters<typeof McpAppToolResult>[0];

function appTree(
  test: Harness | undefined,
  onSessionChange?: (session: McpAppMountedSession | undefined) => void,
  toolCall: typeof TOOL_CALL = TOOL_CALL
): ReactElement {
  return (
    <TooltipProvider>
      <McpAppBridgeProvider bridge={test?.bridge ?? null}>
        <McpAppToolResult
          {...toolCall}
          {...(onSessionChange ? { onSessionChange } : {})}
          {...(test ? { ports: test.ports } : {})}
        />
      </McpAppBridgeProvider>
    </TooltipProvider>
  );
}

function renderApp(
  test: Harness | undefined,
  onSessionChange?: (session: McpAppMountedSession | undefined) => void
) {
  return render(appTree(test, onSessionChange));
}

async function mountApp(test: Harness): Promise<McpAppMountedSession> {
  let session: McpAppMountedSession | undefined;
  const view = renderApp(test, (next) => {
    session = next ?? session;
  });
  await waitFor(() => expect(screen.getByTitle('create_issue app')).toBeInTheDocument());
  await waitFor(() => expect(session).toBeDefined());
  if (!session) {
    throw new Error('MCP app session never connected');
  }
  test.target.dispatch(test.frame, INITIALIZE);
  await waitFor(() => expect(session?.frameBridge.snapshot.phase).toBe('awaiting-initialized'));
  test.target.dispatch(test.frame, INITIALIZED);
  await waitFor(() => expect(session?.frameBridge.snapshot.phase).toBe('ready'));
  return Object.assign(session, { unmount: view.unmount });
}

describe('MCP App tool result', () => {
  it('states that app rendering is unavailable when the host exposes no bridge', () => {
    renderApp(undefined);
    expect(screen.getByTestId('mcp-app-host-note')).toHaveTextContent(
      'App rendering unavailable in this host'
    );
    expect(screen.queryByTitle('create_issue app')).not.toBeInTheDocument();
  });

  it('states that app rendering needs a persisted thread when no thread owns the part', () => {
    const test = harness();
    render(
      <TooltipProvider>
        <McpAppBridgeProvider bridge={test.bridge}>
          <McpAppToolResult {...TOOL_CALL} ports={test.ports} threadId={undefined} />
        </McpAppBridgeProvider>
      </TooltipProvider>
    );
    expect(screen.getByTestId('mcp-app-host-note')).toHaveTextContent(
      'App rendering requires a persisted thread'
    );
    expect(screen.queryByTitle('create_issue app')).not.toBeInTheDocument();
    expect(test.prepare).not.toHaveBeenCalled();
  });

  it('tears the mounted app down when MCP Apps are turned off for its server (BST-1604)', async () => {
    const test = harness();
    let session: McpAppMountedSession | undefined;
    const tree = (appsEnabled: boolean): ReactElement => (
      <TooltipProvider>
        <McpAppsEnablementProvider isEnabled={() => appsEnabled}>
          <McpAppBridgeProvider bridge={test.bridge}>
            <McpAppToolResult
              {...TOOL_CALL}
              onSessionChange={(next) => {
                session = next ?? session;
              }}
              ports={test.ports}
            />
          </McpAppBridgeProvider>
        </McpAppsEnablementProvider>
      </TooltipProvider>
    );
    const view = render(tree(true));
    await waitFor(() => expect(screen.getByTitle('create_issue app')).toBeInTheDocument());
    await waitFor(() => expect(session).toBeDefined());
    expect(test.created).toHaveLength(1);

    view.rerender(tree(false));

    expect(screen.queryByTitle('create_issue app')).not.toBeInTheDocument();
    expect(screen.getByTestId('mcp-app-host-note')).toHaveTextContent(
      'MCP Apps are turned off for this server'
    );
    // The ordinary unmount teardown ran: the served shell was released and the
    // frame bridge and tool-call authority were closed.
    await waitFor(() => expect(test.revoked).toEqual(test.created));
    expect(session?.frameBridge.snapshot.phase).toBe('closed');
  });

  it('keeps the app mounted while its own server stays enabled (BST-1604)', async () => {
    const test = harness();
    render(
      <TooltipProvider>
        <McpAppsEnablementProvider isEnabled={(serverId) => serverId !== 'other'}>
          <McpAppBridgeProvider bridge={test.bridge}>
            <McpAppToolResult {...TOOL_CALL} ports={test.ports} />
          </McpAppBridgeProvider>
        </McpAppsEnablementProvider>
      </TooltipProvider>
    );
    await waitFor(() => expect(screen.getByTitle('create_issue app')).toBeInTheDocument());
  });

  it('mounts the host-served brainstrike-mcp-app: shell URL after reading the app document', async () => {
    const test = harness();
    await mountApp(test);
    expect(test.bridge.readResource).toHaveBeenCalledWith(APP);
    expect(test.bridge.prepareShell).toHaveBeenCalledTimes(1);
    const frame = screen.getByTitle('create_issue app');
    expect(frame).toHaveAttribute('src', test.created[0]);
    expect(frame.getAttribute('src')).toMatch(/^brainstrike-mcp-app:\/\/[0-9a-f]{32}\/$/u);
    expect(test.revoked).toEqual([]);
  });

  it('releases the shell when the mount is torn down while the host is still registering it', async () => {
    const test = harness();
    let resolveShell: ((lease: { shellUrl: string; token: string }) => void) | undefined;
    const slowPrepare = vi.fn(
      () =>
        new Promise<{ shellUrl: string; token: string }>((resolve) => {
          resolveShell = resolve;
        })
    );
    const bridge: McpAppBridge = { ...test.bridge, prepareShell: slowPrepare };
    const view = render(
      <TooltipProvider>
        <McpAppBridgeProvider bridge={bridge}>
          <McpAppToolResult {...TOOL_CALL} ports={test.ports} />
        </McpAppBridgeProvider>
      </TooltipProvider>
    );
    await waitFor(() => expect(slowPrepare).toHaveBeenCalledTimes(1));
    view.unmount();
    const token = 'f'.repeat(32);
    resolveShell?.({ shellUrl: `brainstrike-mcp-app://${token}/`, token });
    await waitFor(() => expect(test.bridge.releaseShell).toHaveBeenCalledWith({ token }));
  });

  it('lets a published SDK 2 app call tools through the production initializer and consent', async () => {
    const user = userEvent.setup();
    const test = harness('ask');
    const [appTransport, frameTransport] = InMemoryTransport.createLinkedPair();
    const app = new App(
      { name: 'Linear', version: '1.0.0' },
      {},
      {
        autoResize: false,
        strict: true,
      }
    );
    frameTransport.onmessage = (message) => test.target.dispatch(test.frame, message);
    test.frame.onMessage = (message) => {
      void frameTransport.send(parseJSONRPCMessage(message));
    };
    const connected = vi.fn();
    const view = renderApp(test, connected);
    try {
      await waitFor(() => expect(connected).toHaveBeenCalled());
      await frameTransport.start();
      await act(async () => await app.connect(appTransport));
      expect(app.getHostCapabilities()).toEqual({ serverTools: {} });
      const result = app.callServerTool({ arguments: { title: 'SDK 2' }, name: 'create_issue' });
      await user.click(await screen.findByRole('button', { name: 'Allow create_issue once' }));
      await expect(result).resolves.toMatchObject({ content: [{ text: 'done', type: 'text' }] });
      expect(test.prepare).toHaveBeenCalledWith({
        arguments: { title: 'SDK 2' },
        origin: APP,
        preparationId: expect.stringContaining('mcp-app-preparation-'),
        threadId: 'thread-a',
        toolName: 'create_issue',
      });
      expect(test.execute).toHaveBeenCalledTimes(1);
    } finally {
      view.unmount();
      await app.close();
      await frameTransport.close();
    }
    await waitFor(() => expect(test.target.listeners.size).toBe(0));
    await waitFor(() => expect(test.revoked).toEqual(test.created));
  });

  it('routes an app tools/call through consent, execution, and the frame reply', async () => {
    const user = userEvent.setup();
    const test = harness('ask');
    const session = await mountApp(test);

    test.target.dispatch(test.frame, {
      id: 'tool-1',
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { arguments: { title: 'Bug' }, name: 'create_issue' },
    });

    const allow = await screen.findByRole('button', { name: 'Allow create_issue once' });
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(test.prepare).toHaveBeenCalledWith({
      arguments: { title: 'Bug' },
      origin: APP,
      preparationId: expect.stringContaining('mcp-app-preparation-'),
      threadId: 'thread-a',
      toolName: 'create_issue',
    });
    expect(test.execute).not.toHaveBeenCalled();

    await user.click(allow);

    await waitFor(() => expect(test.execute).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(test.frame.sent.at(-1)).toMatchObject({
        id: 'tool-1',
        result: { content: [{ text: 'done', type: 'text' }] },
      })
    );
    expect(session.authority.snapshot.pendingCalls).toBe(0);
  });

  it('releases the preparation and never executes when consent is denied', async () => {
    const user = userEvent.setup();
    const test = harness('ask');
    await mountApp(test);

    test.target.dispatch(test.frame, {
      id: 'tool-2',
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { arguments: {}, name: 'create_issue' },
    });

    await user.click(await screen.findByRole('button', { name: 'Deny create_issue' }));

    await waitFor(() => expect(test.release).toHaveBeenCalledTimes(1));
    expect(test.execute).not.toHaveBeenCalled();
    expect(test.release).toHaveBeenCalledWith({
      preparationId: test.prepare.mock.calls[0]?.[0].preparationId,
    });
  });

  it('leaks no ownership after teardown at a pending approval and remounts cleanly', async () => {
    const test = harness('ask');
    let torndown = false;
    let session: McpAppMountedSession | undefined;
    const view = renderApp(test, (next) => {
      if (next) {
        session = next;
        return;
      }
      torndown = true;
    });
    await waitFor(() => expect(session).toBeDefined());
    if (!session) {
      throw new Error('MCP app session never connected');
    }
    test.target.dispatch(test.frame, INITIALIZE);
    await waitFor(() => expect(session?.frameBridge.snapshot.phase).toBe('awaiting-initialized'));
    test.target.dispatch(test.frame, INITIALIZED);
    await waitFor(() => expect(session?.frameBridge.snapshot.phase).toBe('ready'));

    test.target.dispatch(test.frame, {
      id: 'tool-3',
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { arguments: {}, name: 'create_issue' },
    });
    await screen.findByRole('alertdialog');
    const preparationId = test.prepare.mock.calls[0]?.[0].preparationId as string;

    view.unmount();

    await waitFor(() => expect(torndown).toBe(true));
    expect(session.authority.snapshot.pendingCalls).toBe(0);
    expect(session.authority.snapshot.pendingApprovals).toEqual([]);
    expect(session.authority.snapshot.phase).toBe('closed');
    expect(test.release).toHaveBeenCalledTimes(1);
    expect(test.release).toHaveBeenCalledWith({ preparationId });
    expect(test.execute).not.toHaveBeenCalled();
    expect(session.frameBridge.snapshot.pendingCallbacks).toBe(0);
    expect(session.frameBridge.snapshot.pendingInboundRequests).toBe(0);
    expect(session.frameBridge.snapshot.pendingOutboundRequests).toBe(0);
    expect(session.frameBridge.snapshot.timerCount).toBe(0);
    expect(session.sandboxOwner.activeFrames).toBe(0);
    expect(session.sandboxOwner.retainedBytes).toBe(0);
    expect(test.revoked).toEqual([test.created[0]]);
    expect(test.target.listeners.size).toBe(0);

    const second = harness('allow');
    await mountApp(second);
    expect(screen.getByTitle('create_issue app')).toHaveAttribute('src', second.created[0]);
  });

  it('keeps the mount when a parent re-render carries an equal-but-new result object', async () => {
    const test = harness('allow');
    let torndown = false;
    let session: McpAppMountedSession | undefined;
    const onSessionChange = (next: McpAppMountedSession | undefined): void => {
      if (next) {
        session = next;
        return;
      }
      torndown = true;
    };
    const view = render(appTree(test, onSessionChange));
    await waitFor(() => expect(session).toBeDefined());
    const shellUrl = screen.getByTitle('create_issue app').getAttribute('src');

    const equalResult = createMcpAppToolInvocationResult(APP, { content: [] });
    expect(equalResult).not.toBe(APP_RESULT);
    view.rerender(appTree(test, onSessionChange, { ...TOOL_CALL, result: equalResult }));
    view.rerender(appTree(test, onSessionChange, { ...TOOL_CALL, result: equalResult }));

    await waitFor(() => expect(screen.getByTitle('create_issue app')).toBeInTheDocument());
    expect(torndown).toBe(false);
    expect(test.bridge.readResource).toHaveBeenCalledTimes(1);
    expect(screen.getByTitle('create_issue app')).toHaveAttribute('src', shellUrl);
    expect(test.revoked).toEqual([]);
    expect(session?.authority.snapshot.phase).toBe('open');
  });

  it('tears the mount down and starts a fresh one when the app origin changes', async () => {
    const test = harness('allow');
    let torndown = false;
    let session: McpAppMountedSession | undefined;
    const onSessionChange = (next: McpAppMountedSession | undefined): void => {
      if (next) {
        session = next;
        return;
      }
      torndown = true;
    };
    const view = render(appTree(test, onSessionChange));
    await waitFor(() => expect(session).toBeDefined());
    const first = session;

    const otherApp: McpAppOrigin = { ...APP, resourceUri: 'ui://linear/issue-viewer' };
    view.rerender(
      appTree(test, onSessionChange, {
        ...TOOL_CALL,
        result: createMcpAppToolInvocationResult(otherApp, { content: [] }),
      })
    );

    await waitFor(() => expect(torndown).toBe(true));
    await waitFor(() => expect(session).not.toBe(first));
    expect(test.bridge.readResource).toHaveBeenLastCalledWith(otherApp);
    expect(first?.authority.snapshot.phase).toBe('closed');
    expect(test.revoked).toEqual([test.created[0]]);
    await waitFor(() =>
      expect(screen.getByTitle('create_issue app')).toHaveAttribute('src', test.created[1])
    );
  });

  it('reaches the connected state under StrictMode effect double-invocation', async () => {
    const test = harness('allow');
    let session: McpAppMountedSession | undefined;
    render(
      <StrictMode>
        {appTree(test, (next) => {
          session = next ?? session;
        })}
      </StrictMode>
    );
    await waitFor(() => expect(session).toBeDefined());
    await waitFor(() => expect(screen.getByTitle('create_issue app')).toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(session?.authority.snapshot.phase).toBe('open');
    expect(session?.sandboxOwner.activeFrames).toBe(1);
  });

  it('claims only persisted app markers through its renderer descriptor', () => {
    expect(mcpAppToolResultRenderer.kind).toBe('mcp-app');
    expect(mcpAppToolResultRenderer.matches(APP_RESULT)).toBe(true);
    expect(mcpAppToolResultRenderer.matches({ ok: true })).toBe(false);
    expect(mcpAppToolResultRenderer.matches(undefined)).toBe(false);
  });

  it('keeps an ordinary tool result on the shared tool fallback', () => {
    const test = harness();
    const Component = mcpAppToolResultRenderer.Component;
    render(
      <TooltipProvider>
        <McpAppBridgeProvider bridge={test.bridge}>
          <Component {...TOOL_CALL} result={{ ok: true }} />
        </McpAppBridgeProvider>
      </TooltipProvider>
    );
    expect(screen.queryByTitle('create_issue app')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mcp-app-host-note')).not.toBeInTheDocument();
    expect(test.bridge.readResource).not.toHaveBeenCalled();
  });
});

const AppTestRuntimeContext = createContext<{
  readonly onSessionChange: (session: McpAppMountedSession | undefined) => void;
  readonly test: Harness;
} | null>(null);

function InstrumentedAppResult(props: Parameters<typeof McpAppToolResult>[0]): ReactElement {
  const binding = use(AppTestRuntimeContext);
  if (!binding) {
    throw new Error('Instrumented app renderer requires its test runtime.');
  }
  return (
    <McpAppToolResult
      {...props}
      onSessionChange={binding.onSessionChange}
      ports={binding.test.ports}
    />
  );
}

const APP_TEST_RENDERERS = [{ ...mcpAppToolResultRenderer, Component: InstrumentedAppResult }];

function GroupedApp({
  messages,
  onSessionChange,
  isVisible = true,
  test,
}: {
  messages: readonly ThreadMessageLike[];
  onSessionChange: (session: McpAppMountedSession | undefined) => void;
  isVisible?: boolean;
  test: ReturnType<typeof harness>;
}) {
  const runtime = useExternalStoreRuntime({
    convertMessage: (message: ThreadMessageLike) => message,
    messages,
    onNew: async () => {
      throw new Error('Viewing the MCP App must not start a model');
    },
  });
  return (
    <AppTestRuntimeContext.Provider value={{ onSessionChange, test }}>
      <TooltipProvider>
        <McpAppBridgeProvider bridge={test.bridge}>
          <ToolResultRendererProvider renderers={APP_TEST_RENDERERS}>
            <div hidden={!isVisible}>
              <AssistantConversationPanel
                isVisible={isVisible}
                label="MCP lifecycle"
                runtime={runtime}
                threadKey="thread-a"
              />
            </div>
          </ToolResultRendererProvider>
        </McpAppBridgeProvider>
      </TooltipProvider>
    </AppTestRuntimeContext.Provider>
  );
}

it('keeps the grouped MCP App session, pending consent and iframe when activity collapses', async () => {
  const test = harness('ask');
  let session: McpAppMountedSession | undefined;
  const onSessionChange = (next: McpAppMountedSession | undefined): void => {
    if (next) {
      session = next;
    }
  };
  const messages: readonly ThreadMessageLike[] = [
    {
      content: [
        { text: 'Open the editor.', type: 'reasoning' },
        {
          args: {},
          argsText: '{}',
          result: APP_RESULT,
          toolCallId: TOOL_CALL.toolCallId,
          toolName: TOOL_CALL.toolName,
          type: 'tool-call',
        },
      ],
      role: 'assistant',
      status: { reason: 'stop', type: 'complete' },
    },
  ];
  render(<GroupedApp messages={messages} onSessionChange={onSessionChange} test={test} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Expand activity' }));
  await waitFor(() => expect(session).toBeDefined());
  if (!session) {
    throw new Error('MCP App session did not connect');
  }
  const originalSession = session;
  act(() => test.target.dispatch(test.frame, INITIALIZE));
  await waitFor(() =>
    expect(originalSession.frameBridge.snapshot.phase).toBe('awaiting-initialized')
  );
  act(() => test.target.dispatch(test.frame, INITIALIZED));
  await waitFor(() => expect(originalSession.frameBridge.snapshot.phase).toBe('ready'));
  const originalFrame = screen.getByTitle('create_issue app');
  act(() =>
    test.target.dispatch(test.frame, {
      id: 'collapse-call',
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { arguments: {}, name: 'create_issue' },
    })
  );
  await screen.findByRole('alertdialog');
  expect(originalSession.authority.snapshot.pendingApprovals).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Collapse activity' }));
  await act(async () => {
    await Promise.resolve();
  });
  expect(originalSession.authority.snapshot.phase).toBe('open');
  expect(test.release).not.toHaveBeenCalled();
  expect(test.revoked).toEqual([]);
  fireEvent.click(screen.getByRole('button', { name: 'Expand activity' }));
  expect(await screen.findByTitle('create_issue app')).toBe(originalFrame);
  expect(test.created).toHaveLength(1);
  await userEvent.click(await screen.findByRole('button', { name: 'Allow create_issue once' }));
  await waitFor(() => expect(test.execute).toHaveBeenCalledTimes(1));
  await waitFor(() =>
    expect(test.frame.sent.at(-1)).toMatchObject({
      id: 'collapse-call',
      result: { content: [{ text: 'done', type: 'text' }] },
    })
  );
});

it('keeps the full-pane MCP App authority, pending consent and iframe when the pane is hidden', async () => {
  const test = harness('ask');
  let session: McpAppMountedSession | undefined;
  const onSessionChange = (next: McpAppMountedSession | undefined): void => {
    session = next ?? session;
  };
  const messages: readonly ThreadMessageLike[] = [
    {
      content: [
        {
          args: {},
          argsText: '{}',
          result: APP_RESULT,
          toolCallId: TOOL_CALL.toolCallId,
          toolName: TOOL_CALL.toolName,
          type: 'tool-call',
        },
      ],
      role: 'assistant',
      status: { reason: 'stop', type: 'complete' },
    },
  ];
  const tree = (isVisible: boolean): ReactElement => (
    <GroupedApp
      isVisible={isVisible}
      messages={messages}
      onSessionChange={onSessionChange}
      test={test}
    />
  );
  const view = render(tree(true));
  fireEvent.click(await screen.findByRole('button', { name: 'Expand activity' }));
  await waitFor(() => expect(session).toBeDefined());
  if (!session) {
    throw new Error('MCP App session did not connect.');
  }
  const originalSession = session;
  act(() => test.target.dispatch(test.frame, INITIALIZE));
  await waitFor(() =>
    expect(originalSession.frameBridge.snapshot.phase).toBe('awaiting-initialized')
  );
  act(() => test.target.dispatch(test.frame, INITIALIZED));
  await waitFor(() => expect(originalSession.frameBridge.snapshot.phase).toBe('ready'));
  const originalFrame = screen.getByTitle('create_issue app');
  act(() =>
    test.target.dispatch(test.frame, {
      id: 'pane-call',
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { arguments: {}, name: 'create_issue' },
    })
  );
  await screen.findByRole('alertdialog');
  expect(originalSession.authority.snapshot.pendingCalls).toBe(1);
  view.rerender(tree(false));
  await act(async () => {
    await Promise.resolve();
  });
  expect(originalFrame).not.toBeVisible();
  expect(originalSession.authority.snapshot.phase).toBe('open');
  expect(originalSession.frameBridge.snapshot.phase).toBe('ready');
  expect(originalSession.authority.snapshot.pendingCalls).toBe(1);
  expect(originalSession.authority.snapshot.pendingApprovals).toHaveLength(1);
  expect(test.release).not.toHaveBeenCalled();
  expect(test.revoked).toEqual([]);
  view.rerender(tree(true));
  expect(session).toBe(originalSession);
  expect(await screen.findByTitle('create_issue app')).toBe(originalFrame);
  expect(test.created).toHaveLength(1);
  await userEvent.click(await screen.findByRole('button', { name: 'Allow create_issue once' }));
  await waitFor(() => expect(test.execute).toHaveBeenCalledTimes(1));
  await waitFor(() =>
    expect(test.frame.sent.at(-1)).toMatchObject({
      id: 'pane-call',
      result: { content: [{ text: 'done', type: 'text' }] },
    })
  );
});
