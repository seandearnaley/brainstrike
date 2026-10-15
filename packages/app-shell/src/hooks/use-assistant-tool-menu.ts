import { useNativeToolPreferencesStore } from '@brainstrike/app-state/stores/native-tool-preferences-store';
import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import { NATIVE_TOOL_DEFAULTS } from '@brainstrike/assistant-contract/tool-metadata';
import type { AssistantToolMenuConfig, AssistantToolMenuItem } from '@brainstrike/assistant-ui';
import { useCallback, useMemo } from 'react';
import { hasDesktopRuntimeBridge } from '../assistant-panel/use-assistant-execution-controls';
import {
  formatToolLabel,
  getToolDescription,
  resolveAdvertisedNativeToolIds,
  toLocalRuntimeInputSchema,
} from '../assistant-ui-panel-wrapper-runtime';
import { useAssistantMcpMenuState } from './use-assistant-mcp-menu-state';

interface UseAssistantToolMenuArgs {
  /** The thread's runs bind MCP tools (host threads); a legacy thread lists them disabled. */
  readonly runsMcpTools: boolean;
}

interface AssistantToolMenu {
  readonly enabledNativeToolIds: string[];
  readonly toolMenu: AssistantToolMenuConfig;
}

/**
 * The composer's Tools menu: native tool toggles over the saved native tool
 * preferences, the MCP registry's tools and per-tool preferences, Refresh and
 * the tool settings link. Toggles write those same stores, which every send
 * reads, so the menu owns no tool state of its own.
 */
export function useAssistantToolMenu({
  runsMcpTools,
}: UseAssistantToolMenuArgs): AssistantToolMenu {
  const nativeToolStates = useNativeToolPreferencesStore((state) => state.toolStates);
  const setNativeToolEnabled = useNativeToolPreferencesStore((state) => state.setToolEnabled);
  const openSettings = usePanelLayoutStore((state) => state.openSettings);
  const nativeToolIds = resolveAdvertisedNativeToolIds({
    desktopBridgeAvailable: hasDesktopRuntimeBridge(),
  });
  const nativeToolItems = useMemo<AssistantToolMenuItem[]>(
    () =>
      nativeToolIds.map((toolId) => {
        const metadata = NATIVE_TOOL_DEFAULTS[toolId];
        const category =
          typeof (metadata as { category?: unknown }).category === 'string'
            ? (metadata as { category: string }).category
            : undefined;
        const inputSchema = toLocalRuntimeInputSchema(toolId);

        return {
          description: getToolDescription(toolId),
          enabled: typeof nativeToolStates[toolId] === 'boolean' ? nativeToolStates[toolId] : true,
          group: 'Native Tools',
          id: toolId,
          label: formatToolLabel(toolId),
          source: 'native',
          ...(inputSchema ? { inputSchema } : {}),
          isLocalRuntimeRunnable: true,
          ...(category ? { category } : {}),
        };
      }),
    [nativeToolIds, nativeToolStates]
  );
  const handleOpenToolSettings = useCallback(() => {
    openSettings();
    if (typeof window !== 'undefined') {
      window.location.hash = '#settings/ai-tools';
    }
  }, [openSettings]);

  return useAssistantMcpMenuState({
    nativeToolItems,
    onOpenToolSettings: handleOpenToolSettings,
    runsMcpTools,
    setNativeToolEnabled,
  });
}
