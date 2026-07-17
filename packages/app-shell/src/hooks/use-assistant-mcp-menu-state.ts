import type {
  AssistantToolMenuConfig,
  AssistantToolMenuItem,
} from '@brainstrike/ui/assistant-ui-panel';
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import {
  buildMcpMenuItems,
  type McpAction,
  type McpToolMap,
  mcpReducer,
} from '../assistant-ui-panel-wrapper-runtime';

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

  const toolMenuItems = useMemo(
    () => [...nativeToolItems, ...mcpState.tools],
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
    const summary = toolMenuItems.length
      ? `${toolMenuItems.filter((tool) => tool.enabled).length} of ${toolMenuItems.length} enabled`
      : undefined;

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
    onOpenToolSettings,
    toolMenuItems,
  ]);

  return {
    enabledNativeToolIds,
    toolMenu,
  };
}
