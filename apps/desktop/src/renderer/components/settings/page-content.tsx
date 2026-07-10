import {
  isNativeTool,
  NATIVE_TOOL_DEFAULTS,
  TOOL_DESCRIPTIONS,
} from '@brainstrike/agent/tool-metadata';
import { createCostTrackingSettingsCategory } from '@brainstrike/app-shell/cost-tracking';
import { createSystemDiagnosticsSettingsCategory } from '@brainstrike/app-shell/diagnostics';
import { useOptionalTokenCacheContext } from '@brainstrike/file-explorer-ui/indexing';
import { useFileExplorerStoreSelector } from '@brainstrike/file-explorer-ui/shell';
import { configureModelRuntimeServices } from '@brainstrike/preferences/settings/models/model-runtime-services';
import { ModelSelectionPage } from '@brainstrike/preferences/settings/models/model-selection-page';
import { createNotificationSettingsCategory } from '@brainstrike/preferences/settings/system/notification-settings-category';
import {
  createToolsSettingsCategory,
  type ToolDisplayMetadata,
  type ToolExecutionResult,
} from '@brainstrike/preferences/settings/tools/index';
import {
  createApiKeysSettingsCategory,
  createAppearanceSettingsCategory,
  createFactoryResetSettingsCategory,
  createLocalRuntimeSettingsCategory,
  createPermissionSettingsCategory,
  createSearchIndexingSettingsCategory,
  createTokenCountingSettingsCategoryWithRuntimeSupport,
  type SettingsCategory,
  SettingsPageContent as SettingsLayout,
} from '@brainstrike/preferences/settings-page-content';
import { getAccurateRuntimeAvailabilityTestOverride } from '@brainstrike/preferences/settings-test-runtime-access';
import { useNativeToolPreferencesStore } from '@brainstrike/preferences/stores/native-tool-preferences-store';
import { FileCog, Layers } from 'lucide-react';
import { useMemo } from 'react';
import { DesktopLoggingSettings } from './logging-settings';

configureModelRuntimeServices({
  downloadEmbeddingModel: async (modelId, options) => {
    const { SimpleEmbeddingService } = await import('@brainstrike/embeddings/service');
    const service = new SimpleEmbeddingService();
    await service.downloadModel(modelId, options);
  },
});

/**
 * Transform NATIVE_TOOL_DEFAULTS into ToolDisplayMetadata format.
 * Native tools are always enabled by default (can be toggled in settings).
 */
function getNativeToolsAsDisplayMetadata(
  isToolEnabled: (toolId: string) => boolean
): ToolDisplayMetadata[] {
  return Object.entries(NATIVE_TOOL_DEFAULTS).map(([id, metadata]) => ({
    category: metadata.category,
    description: getToolDescription(id),
    enabled: isToolEnabled(id),
    estimatedTokens: metadata.estimatedTokens,
    id,
    loadingTier: metadata.loadingTier,
    requiresApproval: metadata.requiresApproval,
    source: 'native' as const,
  }));
}

/**
 * Get human-readable description for native tools.
 */
function getToolDescription(toolId: string): string {
  return TOOL_DESCRIPTIONS[toolId] ?? `Native tool: ${toolId}`;
}

function EmbeddingModelsCategory() {
  return <ModelSelectionPage />;
}

export default function SettingsPageContent() {
  // Inline fixture state from file explorer store context (shared with FileExplorerLeftPanel)
  const tokenCache = useOptionalTokenCacheContext();
  const devInlineFixtureEnabled = useFileExplorerStoreSelector((s) => s.devInlineFixtureEnabled);
  const setDevInlineFixtureEnabled = useFileExplorerStoreSelector(
    (s) => s.setDevInlineFixtureEnabled
  );
  const accurateRuntimeAvailable = useMemo<boolean | null>(() => {
    // E2E overrides are read on mount/remount only. Tests that mutate them
    // mid-lifecycle should reload or navigate to remount this settings view.
    const override = getAccurateRuntimeAvailabilityTestOverride();
    if (override !== undefined) {
      return override;
    }
    if (!tokenCache) {
      return null;
    }
    return tokenCache.isOperational && tokenCache.countingMode === 'accurate';
  }, [tokenCache]);

  // Create tool operations that integrate with window.mcp and window.tools APIs
  const toolOperations = useMemo(
    () => ({
      disableTools: async (ids: string[]) => {
        const nativeToolIds = ids.filter((id) => isNativeTool(id));
        const mcpToolIds = ids.filter((id) => !isNativeTool(id));

        if (nativeToolIds.length > 0) {
          useNativeToolPreferencesStore.getState().setToolsEnabled(nativeToolIds, false);
        }
        if (mcpToolIds.length > 0) {
          await window.mcp?.disableTools?.(mcpToolIds);
        }
      },
      enableTools: async (ids: string[]) => {
        const nativeToolIds = ids.filter((id) => isNativeTool(id));
        const mcpToolIds = ids.filter((id) => !isNativeTool(id));

        if (nativeToolIds.length > 0) {
          useNativeToolPreferencesStore.getState().setToolsEnabled(nativeToolIds, true);
        }
        if (mcpToolIds.length > 0) {
          await window.mcp?.enableTools?.(mcpToolIds);
        }
      },
      getMcpServerStatus: async () => {
        const tools = await window.mcp?.listTools?.();
        if (!tools) {
          return [];
        }
        return Object.entries(tools).map(([name, serverTools]) => ({
          name,
          status: 'connected' as const,
          toolCount: (serverTools as unknown[]).length,
        }));
      },
      getStats: async () => {
        const { isToolEnabled } = useNativeToolPreferencesStore.getState();
        const nativeTools = getNativeToolsAsDisplayMetadata(isToolEnabled);
        const mcpStats = await window.mcp?.getToolStats?.();

        const nativeCount = nativeTools.length;
        const mcpCount = mcpStats?.total ?? 0;
        const nativeEnabled = nativeTools.filter((t) => t.enabled).length;
        const mcpEnabled = mcpStats?.enabled ?? 0;
        const totalEnabled = nativeEnabled + mcpEnabled;

        // Build category counts - count each category once, add MCP to action
        const byCategory = Object.fromEntries(
          (['retrieval', 'action', 'analysis', 'configuration', 'validation'] as const).map(
            (cat) => [
              cat,
              nativeTools.filter((t) => t.category === cat).length +
                (cat === 'action' ? mcpCount : 0),
            ]
          )
        ) as Record<'retrieval' | 'action' | 'analysis' | 'configuration' | 'validation', number>;

        return {
          byCategory,
          bySource: { mcp: mcpCount, native: nativeCount },
          disabled: nativeCount + mcpCount - totalEnabled,
          enabled: totalEnabled,
          mcpServers: mcpStats?.servers ?? 0,
          total: nativeCount + mcpCount,
        };
      },
      getTools: async (): Promise<ToolDisplayMetadata[]> => {
        // Start with native tools
        const { isToolEnabled } = useNativeToolPreferencesStore.getState();
        const nativeTools = getNativeToolsAsDisplayMetadata(isToolEnabled);

        // Add MCP tools if available
        const mcpToolsData = await window.mcp?.listTools?.();
        const mcpTools: ToolDisplayMetadata[] = [];

        if (mcpToolsData) {
          for (const [serverName, serverTools] of Object.entries(mcpToolsData)) {
            for (const tool of serverTools as Array<{
              id: string;
              description?: string;
              enabled: boolean;
              inputSchema?: unknown;
            }>) {
              mcpTools.push({
                category: 'action',
                description: tool.description ?? '',
                enabled: tool.enabled,
                estimatedTokens: 100,
                id: tool.id,
                inputSchema: tool.inputSchema,
                loadingTier: 'conditional',
                requiresApproval: false,
                serverName,
                source: 'mcp',
              });
            }
          }
        }

        return [...nativeTools, ...mcpTools];
      },
      openMcpConfig: async () => {
        // Open file picker to select a new MCP config file
        const selectedPath = await window.mcp?.selectPath?.();
        if (selectedPath) {
          await window.mcp?.setPath?.(selectedPath);
          // Refresh tools list to pick up changes from new config
          await window.mcp?.listTools?.();
        }
      },
      refreshMcpServers: async () => {
        // Reload tools list to refresh server status
        await window.mcp?.listTools?.();
      },
      resetMcpConfig: async () => {
        // Reset to default config path
        await window.mcp?.setPath?.(null);
        // Refresh tools list to pick up changes
        await window.mcp?.listTools?.();
      },
      resetTools: async () => {
        useNativeToolPreferencesStore.getState().resetTools();
        await window.mcp?.resetTools?.();
      },
      ...(window.mcp?.getPath && {
        getMcpConfigPath: async () => (await window.mcp?.getPath?.()) ?? '',
      }),
      ...(window.mcp?.setPath && {
        setMcpConfigPath: async (configPath: string | null) => {
          const result = await window.mcp?.setPath?.(configPath);
          if (!result?.success) {
            throw new Error('Failed to set MCP config path');
          }
        },
      }),
      ...(window.mcp?.readConfigText && {
        readMcpConfigText: async () => {
          const result = await window.mcp?.readConfigText?.();
          if (!result) {
            throw new Error('Failed to read MCP config text');
          }
          return result;
        },
      }),
      ...(window.mcp?.writeConfigText && {
        writeMcpConfigText: async (content: string) => {
          const result = await window.mcp?.writeConfigText?.(content);
          if (!result) {
            return {
              error: 'Failed to write MCP config text',
              path: '',
              success: false as const,
            };
          }
          return result;
        },
      }),
      createSampleConfig: async () => {
        // Create a sample MCP config file at the default location
        const result = await window.mcp?.createSampleConfig?.();
        if (!result) {
          return { error: 'MCP API not available', path: '', success: false };
        }
        return result;
      },
      executeToolTest: async (toolId: string, input: unknown): Promise<ToolExecutionResult> => {
        // Execute tool via IPC bridge to main process
        if (window.tools?.execute) {
          const result = await window.tools.execute(toolId, input);
          if (result.success) {
            return {
              durationMs: result.durationMs,
              result: result.result,
              success: true as const,
            };
          }
          return {
            durationMs: result.durationMs,
            error: result.error ?? 'Tool execution failed',
            success: false as const,
          };
        }
        // Fallback if tools API not available
        return {
          durationMs: 0,
          error: 'Tool execution API not available',
          success: false as const,
        };
      },
      getMcpConfigInfo: async () => {
        // Get current MCP config info
        const config = await window.mcp?.getConfig?.();
        if (!config) {
          return null;
        }
        return {
          exists: config.exists,
          path: config.path,
          ...(config.error ? { error: config.error } : {}),
        };
      },
    }),
    []
  );

  const categories = useMemo<SettingsCategory[]>(() => {
    const diagnosticsCategory = createSystemDiagnosticsSettingsCategory();

    return [
      createAppearanceSettingsCategory(),
      createSearchIndexingSettingsCategory(),
      createTokenCountingSettingsCategoryWithRuntimeSupport({ accurateRuntimeAvailable }),
      createCostTrackingSettingsCategory(),
      createLocalRuntimeSettingsCategory(),
      createApiKeysSettingsCategory(),
      {
        content: <EmbeddingModelsCategory />,
        description: 'Choose chat and embedding models, manage downloads, and configure providers.',
        icon: Layers,
        id: 'embedding-models',
        keywords: ['embeddings', 'models', 'providers', 'vector', 'llm', 'download'],
        title: 'Models & Providers',
      },
      {
        content: <DesktopLoggingSettings />,
        description: 'Control renderer log verbosity and manage file logging for debugging.',
        icon: FileCog,
        id: 'logging',
        keywords: ['logging', 'diagnostics', 'debugging', 'log file'],
        title: 'Logging & Diagnostics',
      },
      createToolsSettingsCategory({
        mcpAvailable: true,
        operations: toolOperations,
      }),
      createPermissionSettingsCategory(),
      createNotificationSettingsCategory(),
      diagnosticsCategory,
      createFactoryResetSettingsCategory({
        inlineFixtureSetting: {
          available: true,
          checked: devInlineFixtureEnabled,
          loading: false,
          onChange: setDevInlineFixtureEnabled,
        },
        isWebPlatform: false,
      }),
    ];
  }, [
    accurateRuntimeAvailable,
    devInlineFixtureEnabled,
    setDevInlineFixtureEnabled,
    toolOperations,
  ]);

  return (
    <>
      <title>BrainStrike Desktop - Settings</title>
      <meta content="BrainStrike Desktop Settings" name="description" />

      <SettingsLayout categories={categories} defaultCategoryId="appearance" />
    </>
  );
}
