/**
 * BST-1592 — MCP prompt slash-command hook: capability gating by bridge
 * presence (web has none), live reprojection from the revisioned host status
 * channel, and the select-only execute contract (hands the selection plus the
 * captured draft split to the app-wide host; never fetches, never sends).
 */
import type { McpHostSnapshot } from '@brainstrike/assistant-contract';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toastSpy = vi.fn();
vi.mock('@brainstrike/ui', () => ({
  useToast: () => ({ toast: toastSpy }),
}));

import { useAssistantComposerCommandStore } from '../assistant-composer-command-store';
import { useMcpPromptSelectionStore } from '../mcp-prompts/mcp-prompt-selection-store';
import { useMcpPromptSlashCommands } from '../use-mcp-prompt-slash-commands';

type StatusListener = (event: { revision: number; servers: unknown[] }) => void;

interface TestBridge {
  complete: ReturnType<typeof vi.fn>;
  getPrompt: ReturnType<typeof vi.fn>;
  getServerStatusSnapshot: ReturnType<typeof vi.fn>;
  onServerStatusUpdated: (listener: StatusListener) => () => void;
}

const listeners = new Set<StatusListener>();

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
  (window as unknown as { mcp?: unknown }).mcp = bridge;
  return bridge;
}

beforeEach(() => {
  useAssistantComposerCommandStore.getState().reset();
  useMcpPromptSelectionStore.getState().clear();
  listeners.clear();
  toastSpy.mockClear();
});

afterEach(() => {
  (window as unknown as { mcp?: unknown }).mcp = undefined;
  vi.restoreAllMocks();
});

describe('useMcpPromptSlashCommands', () => {
  it('offers nothing without the desktop bridge', () => {
    const { result } = renderHook(() => useMcpPromptSlashCommands('thread-1'));
    expect(result.current).toEqual([]);
  });

  it('offers nothing when the bridge is present but incomplete', async () => {
    (window as unknown as { mcp?: unknown }).mcp = { getPrompt: vi.fn() };
    const { result } = renderHook(() => useMcpPromptSlashCommands('thread-1'));
    await waitFor(() => expect(result.current).toEqual([]));
  });

  it('projects connected server prompts into slash commands', async () => {
    installBridge([connectedServer('alpha', [{ description: 'Review a diff', name: 'review' }])]);
    const { result } = renderHook(() => useMcpPromptSlashCommands('thread-1'));

    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(result.current[0]).toMatchObject({
      description: 'Review a diff',
      id: 'mcp:alpha:review',
      label: 'review · alpha',
    });
  });

  it('reprojects when the host pushes a status update', async () => {
    installBridge([connectedServer('alpha', [{ name: 'review' }])]);
    const { result } = renderHook(() => useMcpPromptSlashCommands('thread-1'));
    await waitFor(() => expect(result.current).toHaveLength(1));

    act(() => {
      for (const listener of listeners) {
        listener({ revision: 2, servers: [] });
      }
    });

    expect(result.current).toEqual([]);
  });

  it('hands the selection and the captured draft split to the host', async () => {
    installBridge([connectedServer('alpha', [{ name: 'review' }])]);
    useAssistantComposerCommandStore
      .getState()
      .recordDraft('thread-1', 'context /mcp:alpha:review tail');
    const { result } = renderHook(() => useMcpPromptSlashCommands('thread-1'));
    await waitFor(() => expect(result.current).toHaveLength(1));

    act(() => result.current[0]?.execute());

    const selection = useMcpPromptSelectionStore.getState().selection;
    expect(selection?.threadId).toBe('thread-1');
    expect(selection?.entry.commandId).toBe('mcp:alpha:review');
    expect(selection?.split).toEqual({ prefix: 'context ', suffix: ' tail' });
    expect(useAssistantComposerCommandStore.getState().commandsByThreadId).toEqual({});
  });

  it('surfaces a visible toast instead of selecting without an active thread', async () => {
    installBridge([connectedServer('alpha', [{ name: 'review' }])]);
    const { result } = renderHook(() => useMcpPromptSlashCommands(undefined));
    await waitFor(() => expect(result.current).toHaveLength(1));

    act(() => result.current[0]?.execute());

    expect(useMcpPromptSelectionStore.getState().selection).toBeNull();
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'No active thread', variant: 'destructive' })
    );
  });
});
