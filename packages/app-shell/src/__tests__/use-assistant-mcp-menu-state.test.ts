import type { AssistantToolMenuItem } from '@brainstrike/assistant-ui';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpToolMap } from '../assistant-ui-panel-wrapper-runtime';
import {
  MCP_LEGACY_THREAD_NOTICE,
  useAssistantMcpMenuState,
} from '../hooks/use-assistant-mcp-menu-state';

type McpApi = NonNullable<Window['mcp']>;

function setMcpApi(overrides: Partial<McpApi> = {}): McpApi {
  const api: McpApi = {
    disableTools: vi.fn().mockResolvedValue(undefined),
    enableTools: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue({}),
    onToolsUpdated: vi.fn().mockReturnValue(() => undefined),
    ...overrides,
  };
  window.mcp = api;
  return api;
}

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
    Reflect.deleteProperty(window, 'mcp');
    window.location.hash = '';
    vi.restoreAllMocks();
  });

  it('loads MCP tools, combines them with native tools, and exposes enabled native ids', async () => {
    const mcpApi = setMcpApi({
      listTools: vi.fn().mockResolvedValue({
        'mcp-server': [
          {
            description: 'Test MCP tool',
            enabled: true,
            id: 'mcp.tool',
          },
        ],
      }),
    });

    const { result } = renderHook(() =>
      useAssistantMcpMenuState({
        nativeToolItems,
        onOpenToolSettings: vi.fn(),
        setNativeToolEnabled: vi.fn(),
      })
    );

    await waitFor(() => {
      expect(result.current.toolMenu.items.map((tool) => tool.id)).toEqual([
        'native.search',
        'mcp.tool',
      ]);
    });

    expect(mcpApi.listTools).toHaveBeenCalledTimes(1);
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

  it('toggles native tools locally and MCP tools over the bridge before reloading', async () => {
    const setNativeToolEnabled = vi.fn();
    const mcpApi = setMcpApi({
      listTools: vi.fn().mockResolvedValue({
        'mcp-server': [
          {
            enabled: false,
            id: 'mcp.tool',
          },
        ],
      }),
    });

    const { result } = renderHook(() =>
      useAssistantMcpMenuState({
        nativeToolItems,
        onOpenToolSettings: vi.fn(),
        setNativeToolEnabled,
      })
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
    expect(mcpApi.enableTools).toHaveBeenCalledWith(['mcp.tool']);
    expect(mcpApi.listTools).toHaveBeenCalledTimes(2);
  });

  it('subscribes to desktop MCP tool updates and unsubscribes on unmount', async () => {
    let publishTools: ((toolsByServer: McpToolMap) => void) | undefined;
    const unsubscribe = vi.fn();
    const mcpApi = setMcpApi({
      listTools: vi.fn().mockResolvedValue({}),
      onToolsUpdated: vi
        .fn()
        .mockImplementation((callback: (toolsByServer: McpToolMap) => void) => {
          publishTools = callback;
          return unsubscribe;
        }),
    });

    const { result, unmount } = renderHook(() =>
      useAssistantMcpMenuState({
        nativeToolItems,
        onOpenToolSettings: vi.fn(),
        setNativeToolEnabled: vi.fn(),
      })
    );

    await waitFor(() => {
      expect(result.current.toolMenu.items).toHaveLength(1);
    });
    expect(mcpApi.onToolsUpdated).toHaveBeenCalledTimes(1);

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

  it('delegates tool settings navigation', async () => {
    const onOpenToolSettings = vi.fn();
    setMcpApi();

    const { result } = renderHook(() =>
      useAssistantMcpMenuState({
        nativeToolItems,
        onOpenToolSettings,
        setNativeToolEnabled: vi.fn(),
      })
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
