import type { AssistantToolMenuItem } from '@brainstrike/assistant-ui';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { McpToolMap } from '../assistant-ui-panel-wrapper-runtime';
import {
  MCP_LEGACY_THREAD_NOTICE,
  useAssistantMcpMenuState,
} from '../hooks/use-assistant-mcp-menu-state';
import { type McpToolsCapability, McpToolsCapabilityProvider } from '../mcp-tools-capability';

interface FakeMcpTools extends McpToolsCapability {
  readonly list: Mock<McpToolsCapability['list']>;
  readonly setEnabled: Mock<McpToolsCapability['setEnabled']>;
  readonly subscribe: Mock<McpToolsCapability['subscribe']>;
}

let capability: FakeMcpTools | null = null;

/** The host's MCP tools, as the visible host provides them to the composer. */
function provideMcpTools(overrides: Partial<FakeMcpTools> = {}): FakeMcpTools {
  capability = {
    list: vi.fn().mockResolvedValue({}),
    setEnabled: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockReturnValue(() => undefined),
    ...overrides,
  };
  return capability;
}

const wrapper = ({ children }: { readonly children: ReactNode }) =>
  createElement(McpToolsCapabilityProvider, { capability, children });

const nativeToolItems: AssistantToolMenuItem[] = [
  {
    description: 'Search native files',
    enabled: true,
    group: 'Native Tools',
    id: 'native.search',
    label: 'Native Search',
    source: 'native',
  },
];

describe('useAssistantMcpMenuState', () => {
  afterEach(() => {
    capability = null;
    window.location.hash = '';
    vi.restoreAllMocks();
  });

  it('loads MCP tools, combines them with native tools, and exposes enabled native ids', async () => {
    const mcpTools = provideMcpTools({
      list: vi.fn().mockResolvedValue({
        'mcp-server': [
          {
            description: 'Test MCP tool',
            enabled: true,
            id: 'mcp.tool',
          },
        ],
      }),
    });

    const { result } = renderHook(
      () =>
        useAssistantMcpMenuState({
          nativeToolItems,
          onOpenToolSettings: vi.fn(),
          runsMcpTools: false,
          setNativeToolEnabled: vi.fn(),
        }),
      { wrapper }
    );

    await waitFor(() => {
      expect(result.current.toolMenu.items.map((tool) => tool.id)).toEqual([
        'native.search',
        'mcp.tool',
      ]);
    });

    expect(mcpTools.list).toHaveBeenCalledTimes(1);
    expect(result.current.enabledNativeToolIds).toEqual(['native.search']);
    expect(result.current.toolMenu.isLoading).toBe(false);
    // Legacy threads no longer run MCP (BST-1930): the tool stays listed, disabled.
    expect(result.current.toolMenu.items.find((tool) => tool.id === 'mcp.tool')).toMatchObject({
      description: MCP_LEGACY_THREAD_NOTICE,
      disabled: true,
    });
    expect(result.current.toolMenu.summary).toBe(`1 of 1 enabled · ${MCP_LEGACY_THREAD_NOTICE}`);
    expect(result.current.toolMenu.onRefresh).toBeTypeOf('function');
  });

  it('lists MCP tools as runnable toggles where the thread runs them', async () => {
    provideMcpTools({
      list: vi.fn().mockResolvedValue({
        'mcp-server': [
          { description: 'Test MCP tool', enabled: true, id: 'mcp.tool' },
          { enabled: false, id: 'mcp.off' },
        ],
      }),
    });

    const { result } = renderHook(
      () =>
        useAssistantMcpMenuState({
          nativeToolItems,
          onOpenToolSettings: vi.fn(),
          runsMcpTools: true,
          setNativeToolEnabled: vi.fn(),
        }),
      { wrapper }
    );

    await waitFor(() => {
      expect(result.current.toolMenu.items).toHaveLength(3);
    });
    const tool = result.current.toolMenu.items.find((item) => item.id === 'mcp.tool');
    expect(tool).toMatchObject({ description: 'Test MCP tool', enabled: true, source: 'mcp' });
    expect(tool?.disabled).toBeUndefined();
    // Every listed tool runs, so every one counts.
    expect(result.current.toolMenu.summary).toBe('2 of 3 enabled');
  });

  it('toggles native tools locally and MCP tools through the host before reloading', async () => {
    const setNativeToolEnabled = vi.fn();
    const mcpTools = provideMcpTools({
      list: vi.fn().mockResolvedValue({
        'mcp-server': [
          {
            enabled: false,
            id: 'mcp.tool',
          },
        ],
      }),
    });

    const { result } = renderHook(
      () =>
        useAssistantMcpMenuState({
          nativeToolItems,
          onOpenToolSettings: vi.fn(),
          runsMcpTools: false,
          setNativeToolEnabled,
        }),
      { wrapper }
    );

    await waitFor(() => {
      expect(result.current.toolMenu.items.some((tool) => tool.id === 'mcp.tool')).toBe(true);
    });

    const onToggleTool = result.current.toolMenu.onToggleTool;
    if (!onToggleTool) {
      throw new Error('expected tool menu toggle handler');
    }

    await act(async () => {
      await onToggleTool('native.search', false);
    });
    expect(setNativeToolEnabled).toHaveBeenCalledWith('native.search', false);

    await act(async () => {
      await onToggleTool('mcp.tool', true);
    });
    expect(mcpTools.setEnabled).toHaveBeenCalledWith(['mcp.tool'], true);
    expect(mcpTools.list).toHaveBeenCalledTimes(2);
  });

  it('subscribes to MCP tool updates from the host and unsubscribes on unmount', async () => {
    let publishTools: ((toolsByServer: McpToolMap) => void) | undefined;
    const unsubscribe = vi.fn();
    const mcpTools = provideMcpTools({
      list: vi.fn().mockResolvedValue({}),
      subscribe: vi.fn().mockImplementation((callback: (toolsByServer: McpToolMap) => void) => {
        publishTools = callback;
        return unsubscribe;
      }),
    });

    const { result, unmount } = renderHook(
      () =>
        useAssistantMcpMenuState({
          nativeToolItems,
          onOpenToolSettings: vi.fn(),
          runsMcpTools: false,
          setNativeToolEnabled: vi.fn(),
        }),
      { wrapper }
    );

    await waitFor(() => {
      expect(result.current.toolMenu.items).toHaveLength(1);
    });
    expect(mcpTools.subscribe).toHaveBeenCalledTimes(1);

    act(() => {
      publishTools?.({
        filesystem: [
          {
            description: 'List directory contents',
            enabled: true,
            id: 'filesystem.list_directory',
          },
        ],
      });
    });

    await waitFor(() => {
      expect(result.current.toolMenu.items.map((tool) => tool.id)).toEqual([
        'native.search',
        'filesystem.list_directory',
      ]);
    });

    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('lists no MCP tools and offers no refresh where the host has no MCP', async () => {
    const { result } = renderHook(() =>
      useAssistantMcpMenuState({
        nativeToolItems,
        onOpenToolSettings: vi.fn(),
        runsMcpTools: true,
        setNativeToolEnabled: vi.fn(),
      })
    );

    await waitFor(() => {
      expect(result.current.toolMenu.isLoading).toBe(false);
    });
    expect(result.current.toolMenu.items.map((tool) => tool.id)).toEqual(['native.search']);
    expect(result.current.toolMenu.onRefresh).toBeUndefined();
  });

  it('delegates tool settings navigation', async () => {
    const onOpenToolSettings = vi.fn();
    provideMcpTools();

    const { result } = renderHook(
      () =>
        useAssistantMcpMenuState({
          nativeToolItems,
          onOpenToolSettings,
          runsMcpTools: false,
          setNativeToolEnabled: vi.fn(),
        }),
      { wrapper }
    );

    const onOpenSettings = result.current.toolMenu.onOpenSettings;
    if (!onOpenSettings) {
      throw new Error('expected tool menu settings handler');
    }

    act(() => {
      onOpenSettings();
    });

    expect(onOpenToolSettings).toHaveBeenCalledTimes(1);
  });
});
