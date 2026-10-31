import type { AssistantToolMenuConfig, AssistantToolMenuItem } from '@brainstrike/assistant-ui';
import { useEffect, useMemo, useReducer, useRef } from 'react';
import {
  buildMcpMenuItems,
  type McpAction,
  mcpReducer,
} from '../assistant-ui-panel-wrapper-runtime';
import { useMcpToolsCapability } from '../use-mcp-tools-capability';

/** Shown wherever the legacy composer lists MCP tools it can no longer run. */
export const MCP_LEGACY_THREAD_NOTICE = 'MCP tools are available in new threads';

interface UseAssistantMcpMenuStateArgs {
  readonly nativeToolItems: readonly AssistantToolMenuItem[];
  readonly onOpenToolSettings: () => void;
  /** The thread's runs bind MCP tools; a legacy thread lists them disabled. */
  readonly runsMcpTools: boolean;
  readonly setNativeToolEnabled: (toolId: string, enabled: boolean) => void;
}

interface UseAssistantMcpMenuStateResult {
  readonly enabledNativeToolIds: string[];
  readonly toolMenu: AssistantToolMenuConfig;
}

export function useAssistantMcpMenuState({
  nativeToolItems,
  onOpenToolSettings,
  runsMcpTools,
  setNativeToolEnabled,
}: UseAssistantMcpMenuStateArgs): UseAssistantMcpMenuStateResult {
  const [mcpState, dispatchMcp] = useReducer(mcpReducer, { loading: false, tools: [] });
  const mcpTools = useMcpToolsCapability();
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const dispatchMcpIfMounted = (action: McpAction) => {
    if (isMountedRef.current) {
      dispatchMcp(action);
    }
  };

  const loadMcpTools = async () => {
    if (!mcpTools) {
      dispatchMcpIfMounted({ tools: [], type: 'LOADED' });
      return;
    }

    dispatchMcpIfMounted({ type: 'LOADING' });
    try {
      dispatchMcpIfMounted({ tools: buildMcpMenuItems(await mcpTools.list()), type: 'LOADED' });
    } catch {
      dispatchMcpIfMounted({ type: 'ERROR' });
    }
  };

  useEffect(() => {
    void loadMcpTools();
  }, [loadMcpTools]);

  useEffect(() => {
    if (!mcpTools) {
      return;
    }
    return mcpTools.subscribe((toolsByServer) => {
      dispatchMcpIfMounted({ tools: buildMcpMenuItems(toolsByServer), type: 'LOADED' });
    });
  }, [dispatchMcpIfMounted, mcpTools]);

  const enabledNativeToolIds = nativeToolItems
    .filter((tool) => tool.enabled !== false)
    .map((tool) => tool.id);

  // Legacy threads no longer carry MCP (BST-1930): there the tools stay listed,
  // visibly unavailable, because new (host) threads run them.
  const toolMenuItems = [
    ...nativeToolItems,
    ...(runsMcpTools
      ? mcpState.tools
      : mcpState.tools.map((tool) => ({
          ...tool,
          description: MCP_LEGACY_THREAD_NOTICE,
          disabled: true,
        }))),
  ];

  const toolSourceById = useMemo(() => {
    const entries = toolMenuItems.map((tool) => [tool.id, tool.source] as const);
    return new Map(entries);
  }, [toolMenuItems]);

  const handleToggleTool = async (toolId: string, enabled: boolean) => {
    const source = toolSourceById.get(toolId);
    if (!source) {
      return;
    }
    if (source === 'native') {
      setNativeToolEnabled(toolId, enabled);
      return;
    }

    await mcpTools?.setEnabled([toolId], enabled);
    await loadMcpTools();
  };

  const canRefreshMcp = mcpTools !== null;

  const toolMenu = useMemo<AssistantToolMenuConfig>(() => {
    // Only tools the thread can run count toward "N of M enabled".
    const counted = runsMcpTools ? toolMenuItems : nativeToolItems;
    const counts = counted.length
      ? `${counted.filter((tool) => tool.enabled).length} of ${counted.length} enabled`
      : undefined;
    const summary =
      !runsMcpTools && mcpState.tools.length > 0
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
    runsMcpTools,
    toolMenuItems,
  ]);

  return {
    enabledNativeToolIds,
    toolMenu,
  };
}
