import type { AssistantToolMenuConfig, AssistantToolMenuItem } from '@brainstrike/assistant-ui';
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import {
  buildMcpMenuItems,
  type McpAction,
  type McpToolMap,
  mcpReducer,
} from '../assistant-ui-panel-wrapper-runtime';

/** Shown wherever the legacy composer lists MCP tools it can no longer run. */
export const MCP_LEGACY_THREAD_NOTICE = 'MCP tools are available in new threads';

interface UseAssistantMcpMenuStateArgs {
  readonly nativeToolItems: readonly AssistantToolMenuItem[];
  readonly onOpenToolSettings: () => void;
  readonly setNativeToolEnabled: (toolId: string, enabled: boolean) => void;
}

interface UseAssistantMcpMenuStateResult {
  readonly enabledNativeToolIds: string[];
  readonly toolMenu: AssistantToolMenuConfig;
}

export function useAssistantMcpMenuState({
  nativeToolItems,
  onOpenToolSettings,
  setNativeToolEnabled,
}: UseAssistantMcpMenuStateArgs): UseAssistantMcpMenuStateResult {
  const [mcpState, dispatchMcp] = useReducer(mcpReducer, { loading: false, tools: [] });
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const dispatchMcpIfMounted = useCallback((action: McpAction) => {
    if (isMountedRef.current) {
      dispatchMcp(action);
    }
  }, []);

  const loadMcpTools = useCallback(async () => {
    if (typeof window === 'undefined' || !window.mcp?.listTools) {
      dispatchMcpIfMounted({ tools: [], type: 'LOADED' });
      return;
    }

    dispatchMcpIfMounted({ type: 'LOADING' });
    try {
      const toolsByServer = (await window.mcp.listTools()) as McpToolMap;
      dispatchMcpIfMounted({ tools: buildMcpMenuItems(toolsByServer), type: 'LOADED' });
    } catch {
      dispatchMcpIfMounted({ type: 'ERROR' });
    }
  }, [dispatchMcpIfMounted]);

  useEffect(() => {
    void loadMcpTools();
  }, [loadMcpTools]);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.mcp?.onToolsUpdated) {
      return;
    }

    return window.mcp.onToolsUpdated((toolsByServer: McpToolMap) => {
      dispatchMcpIfMounted({ tools: buildMcpMenuItems(toolsByServer), type: 'LOADED' });
    });
  }, [dispatchMcpIfMounted]);

  const enabledNativeToolIds = useMemo(
    () => nativeToolItems.filter((tool) => tool.enabled !== false).map((tool) => tool.id),
    [nativeToolItems]
  );

  // This composer runs legacy threads, which no longer carry MCP (BST-1930): the
  // tools stay listed, visibly unavailable here, because new threads run them.
  const toolMenuItems = useMemo(
    () => [
      ...nativeToolItems,
      ...mcpState.tools.map((tool) => ({
        ...tool,
        description: MCP_LEGACY_THREAD_NOTICE,
        disabled: true,
      })),
    ],
    [nativeToolItems, mcpState.tools]
  );

  const toolSourceById = useMemo(() => {
    const entries = toolMenuItems.map((tool) => [tool.id, tool.source] as const);
    return new Map(entries);
  }, [toolMenuItems]);

  const handleToggleTool = useCallback(
    async (toolId: string, enabled: boolean) => {
      const source = toolSourceById.get(toolId);
      if (!source) {
        return;
      }
      if (source === 'native') {
        setNativeToolEnabled(toolId, enabled);
        return;
      }

      if (enabled) {
        await window.mcp?.enableTools?.([toolId]);
      } else {
        await window.mcp?.disableTools?.([toolId]);
      }
      await loadMcpTools();
    },
    [loadMcpTools, setNativeToolEnabled, toolSourceById]
  );

  const canRefreshMcp =
    typeof window !== 'undefined' && typeof window.mcp?.listTools === 'function';

  const toolMenu = useMemo<AssistantToolMenuConfig>(() => {
    const counts = nativeToolItems.length
      ? `${nativeToolItems.filter((tool) => tool.enabled).length} of ${nativeToolItems.length} enabled`
      : undefined;
    const summary =
      mcpState.tools.length > 0
        ? [counts, MCP_LEGACY_THREAD_NOTICE].filter(Boolean).join(' · ')
        : counts;

    return {
      isLoading: mcpState.loading,
      items: toolMenuItems,
      onOpenSettings: onOpenToolSettings,
      onToggleTool: handleToggleTool,
      ...(summary ? { summary } : {}),
      ...(canRefreshMcp ? { onRefresh: loadMcpTools } : {}),
    };
  }, [
    canRefreshMcp,
    handleToggleTool,
    loadMcpTools,
    mcpState.loading,
    mcpState.tools.length,
    nativeToolItems,
    onOpenToolSettings,
    toolMenuItems,
  ]);

  return {
    enabledNativeToolIds,
    toolMenu,
  };
}
