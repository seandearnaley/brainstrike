/**
 * BST-1592 — MCP prompt slash-command hook: capability gating by bridge
 * presence (web has none), live reprojection from the revisioned host status
 * channel, and the select-only execute contract (hands the selection plus the
 * captured draft split to the app-wide host; never fetches, never sends).
 */
import type { McpHostSnapshot } from '@brainstrike/assistant-contract';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toastSpy = vi.fn();
vi.mock('@brainstrike/ui', () => ({
  useToast: () => ({ toast: toastSpy }),
}));

import { useAssistantComposerCommandStore } from '../assistant-composer-command-store';
import { type McpContentCapability, McpContentCapabilityProvider } from '../mcp-content-capability';
import { useMcpPromptSelectionStore } from '../mcp-prompts/mcp-prompt-selection-store';
import { type McpStatusCapability, McpStatusCapabilityProvider } from '../mcp-status-capability';
import { useMcpPromptSlashCommands } from '../use-mcp-prompt-slash-commands';

type StatusListener = (event: McpHostSnapshot) => void;

interface TestBridge {
  complete: ReturnType<typeof vi.fn>;
  getPrompt: ReturnType<typeof vi.fn>;
  getServerStatusSnapshot: () => Promise<McpHostSnapshot>;
  onServerStatusUpdated: (listener: StatusListener) => () => void;
}

const listeners = new Set<StatusListener>();
/** The agent host's MCP status the desktop provides (BST-1930 c5b); `null` like web. */
let status: McpStatusCapability | null = null;
/** The agent host's prompt content the desktop provides (BST-1930 c5d); `null` like web. */
let content: McpContentCapability | null = null;

/** The desktop provides both content and status from the agent host. */
function install(bridge: TestBridge): void {
  content = {
    complete: bridge.complete,
    getPrompt: bridge.getPrompt,
  } as unknown as McpContentCapability;
  status = { read: bridge.getServerStatusSnapshot, subscribe: bridge.onServerStatusUpdated };
}

function wrapper({ children }: { readonly children: ReactNode }) {
  return (
    <McpStatusCapabilityProvider capability={status}>
      <McpContentCapabilityProvider capability={content}>{children}</McpContentCapabilityProvider>
    </McpStatusCapabilityProvider>
  );
}

function connectedServer(id: string, prompts: unknown[], generation = 7): unknown {
  return {
    catalog: {
      errors: {},
      features: {
        completion: true,
        promptListChanged: false,
        prompts: true,
        resourceListChanged: false,
        resourceSubscriptions: false,
        resources: false,
        toolListChanged: false,
      },
      prompts: { prompts },
      subscription: { mode: 'none', state: 'closed' },
    },
    configuredProtocol: '2026-07-28',
    configuredServerId: id,
    generation,
    negotiated: { revision: '2026-07-28' },
    state: 'connected',
    transport: 'streamable-http',
  };
}

function installBridge(servers: unknown[]): TestBridge {
  const bridge: TestBridge = {
    complete: vi.fn(),
    getPrompt: vi.fn(),
    getServerStatusSnapshot: vi.fn(
      async () => ({ revision: 1, servers }) as unknown as McpHostSnapshot
    ),
    onServerStatusUpdated: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  install(bridge);
  return bridge;
}

beforeEach(() => {
  useAssistantComposerCommandStore.getState().reset();
  useMcpPromptSelectionStore.getState().clear();
  listeners.clear();
  status = null;
  content = null;
  toastSpy.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useMcpPromptSlashCommands', () => {
  it('offers nothing without the desktop bridge', () => {
    const { result } = renderHook(() => useMcpPromptSlashCommands('thread-1'), { wrapper });
    expect(result.current).toEqual([]);
  });

  // A partial bridge stays SILENT here on purpose: `McpPromptComposerHost` is
  // always mounted and owns the one visible report, so the composer surface
  // cannot double-toast it.
  it('offers nothing when the bridge is present but incomplete', async () => {
    content = { complete: vi.fn(), getPrompt: vi.fn() };
    const { result } = renderHook(() => useMcpPromptSlashCommands('thread-1'), { wrapper });
    await waitFor(() => expect(result.current).toEqual([]));
  });

  it('projects connected server prompts into slash commands', async () => {
    installBridge([connectedServer('alpha', [{ description: 'Review a diff', name: 'review' }])]);
    const { result } = renderHook(() => useMcpPromptSlashCommands('thread-1'), { wrapper });

    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(result.current[0]).toMatchObject({
      description: 'Review a diff',
      id: 'mcp:alpha:review',
      label: 'review · alpha',
    });
  });

  it('reprojects when the host pushes a status update', async () => {
    installBridge([connectedServer('alpha', [{ name: 'review' }])]);
    const { result } = renderHook(() => useMcpPromptSlashCommands('thread-1'), { wrapper });
    await waitFor(() => expect(result.current).toHaveLength(1));

    act(() => {
      for (const listener of listeners) {
        listener({ revision: 2, servers: [] });
      }
    });

    expect(result.current).toEqual([]);
  });

  it('drops an initial snapshot older than a pushed update that already applied', async () => {
    // Two independent channels feed the same state. The effect GENERATION
    // separates effect runs but says nothing about their ordering, so an
    // initial read issued at revision 4 could still land after a pushed
    // revision 5 and restore the pre-update prompt list.
    const servers = [connectedServer('alpha', [{ name: 'review' }])];
    let resolveInitial: ((snapshot: McpHostSnapshot) => void) | undefined;
    install({
      complete: vi.fn(),
      getPrompt: vi.fn(),
      getServerStatusSnapshot: vi.fn(
        () =>
          new Promise<McpHostSnapshot>((resolve) => {
            resolveInitial = resolve;
          })
      ),
      onServerStatusUpdated: (listener: StatusListener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    const { result } = renderHook(() => useMcpPromptSlashCommands('thread-1'), { wrapper });
    await waitFor(() => expect(listeners.size).toBe(1));

    act(() => {
      for (const listener of listeners) {
        listener({ revision: 5, servers: [] });
      }
    });
    expect(result.current).toEqual([]);

    await act(async () => {
      resolveInitial?.({ revision: 4, servers } as unknown as McpHostSnapshot);
      await Promise.resolve();
    });

    expect(result.current).toEqual([]);
  });

  it('hands the selection and the captured draft split to the host', async () => {
    installBridge([connectedServer('alpha', [{ name: 'review' }])]);
    useAssistantComposerCommandStore
      .getState()
      .recordDraft('thread-1', 'context /mcp:alpha:review tail');
    const { result } = renderHook(() => useMcpPromptSlashCommands('thread-1'), { wrapper });
    await waitFor(() => expect(result.current).toHaveLength(1));

    act(() => result.current[0]?.execute());

    const selection = useMcpPromptSelectionStore.getState().selection;
    expect(selection?.threadId).toBe('thread-1');
    expect(selection?.entry.commandId).toBe('mcp:alpha:review');
    expect(selection?.split).toEqual({ prefix: 'context ', suffix: ' tail' });
    // The pre-strip draft travels with the selection so the host can tell a
    // draft the user has since edited from one it may still replace.
    expect(selection?.draftText).toBe('context /mcp:alpha:review tail');
    expect(useAssistantComposerCommandStore.getState().commandsByThreadId).toEqual({});
  });

  it('surfaces a visible toast instead of selecting without an active thread', async () => {
    installBridge([connectedServer('alpha', [{ name: 'review' }])]);
    const { result } = renderHook(() => useMcpPromptSlashCommands(undefined), { wrapper });
    await waitFor(() => expect(result.current).toHaveLength(1));

    act(() => result.current[0]?.execute());

    expect(useMcpPromptSelectionStore.getState().selection).toBeNull();
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'No active thread', variant: 'destructive' })
    );
  });
});
