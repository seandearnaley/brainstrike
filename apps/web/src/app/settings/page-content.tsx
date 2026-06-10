import {
  isNativeTool,
  NATIVE_TOOL_DEFAULTS,
  type NativeToolDefaultMetadata,
  TOOL_DESCRIPTIONS,
} from '@brainstrike/agent/tool-metadata';
import { createSystemDiagnosticsSettingsCategory } from '@brainstrike/app-shell/diagnostics';
import { useRestoreAccess } from '@brainstrike/file-explorer-hooks';
import { useOptionalTokenCacheContext } from '@brainstrike/file-explorer-ui/indexing';
import { useFileExplorerStoreSelector } from '@brainstrike/file-explorer-ui/shell';
import { createAgentHubSettingsCategory } from '@brainstrike/preferences/settings/agent-hub/index';
import { configureModelRuntimeServices } from '@brainstrike/preferences/settings/models/model-runtime-services';
import { ModelSelectionPage } from '@brainstrike/preferences/settings/models/model-selection-page';
import {
  LoggingSettingsSection,
  type LogSourceAdapter,
} from '@brainstrike/preferences/settings/system/logging-settings-section';
import {
  createToolsSettingsCategory,
  type ToolDisplayMetadata,
  type ToolExecutionResult,
} from '@brainstrike/preferences/settings/tools/index';
import {
  createAppearanceSettingsCategory,
  createFactoryResetSettingsCategory,
  createLocalRuntimeSettingsCategory,
  createSearchIndexingSettingsCategory,
  createTokenCountingSettingsCategoryWithRuntimeSupport,
  type SettingsCategory,
  SettingsPageContent as SettingsLayout,
} from '@brainstrike/preferences/settings-page-content';
import { getAccurateRuntimeAvailabilityTestOverride } from '@brainstrike/preferences/settings-test-runtime-access';
import { useNativeToolPreferencesStore } from '@brainstrike/preferences/stores/native-tool-preferences-store';
import { FileCog, Layers } from 'lucide-react';
import { useMemo } from 'react';
import { Helmet } from 'react-helmet-async';
import { getWebLogBuffer } from '../../log-buffer';

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
  return Object.entries(NATIVE_TOOL_DEFAULTS as Record<string, NativeToolDefaultMetadata>).map(
    ([id, metadata]: [string, NativeToolDefaultMetadata]) => ({
      id,
      source: 'native' as const,
      category: metadata.category,
      loadingTier: metadata.loadingTier,
      description: getToolDescription(id),
      enabled: isToolEnabled(id),
      estimatedTokens: metadata.estimatedTokens,
      requiresApproval: metadata.requiresApproval,
    })
  );
}

/**
 * Get human-readable description for native tools.
 */
function getToolDescription(toolId: string): string {
  return TOOL_DESCRIPTIONS[toolId] ?? `Native tool: ${toolId}`;
}

function ModelSelectionCategory() {
  return (
    <div className="space-y-4">
      <ModelSelectionPage />
    </div>
  );
}

// Factory Reset category provided via createFactoryResetSettingsCategory()

export default function SettingsPageContent() {
  const { storedFolders, clearStoredHandles } = useRestoreAccess();
  const tokenCache = useOptionalTokenCacheContext();

  // Inline fixture state from file explorer store context
  const devInlineFixtureEnabled = useFileExplorerStoreSelector((s) => s.devInlineFixtureEnabled);
  const setDevInlineFixtureEnabled = useFileExplorerStoreSelector(
    (s) => s.setDevInlineFixtureEnabled
  );

  const logSource = useMemo<LogSourceAdapter>(() => {
    const buffer = getWebLogBuffer();
    return {
      getInitialRecords: async () => buffer.getRecords(),
      subscribe: (handler) => buffer.subscribe(handler),
    };
  }, []);

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

  // Tool operations for native tools (web has no MCP support)
  const toolOperations = useMemo(
    () => ({
      getTools: async (): Promise<ToolDisplayMetadata[]> => {
        // Return native tools - web app doesn't have MCP
        const { isToolEnabled } = useNativeToolPreferencesStore.getState();
        return getNativeToolsAsDisplayMetadata(isToolEnabled);
      },
      getStats: async () => {
        const { isToolEnabled } = useNativeToolPreferencesStore.getState();
        const nativeTools = getNativeToolsAsDisplayMetadata(isToolEnabled);
        const nativeCount = nativeTools.length;
        const nativeEnabled = nativeTools.filter((t) => t.enabled).length;

        return {
          total: nativeCount,
          enabled: nativeEnabled,
          disabled: nativeCount - nativeEnabled,
          bySource: { native: nativeCount, mcp: 0 },
          byCategory: {
            retrieval: nativeTools.filter((t) => t.category === 'retrieval').length,
            action: nativeTools.filter((t) => t.category === 'action').length,
            analysis: nativeTools.filter((t) => t.category === 'analysis').length,
            configuration: nativeTools.filter((t) => t.category === 'configuration').length,
            validation: nativeTools.filter((t) => t.category === 'validation').length,
          },
          mcpServers: 0,
        };
      },
      enableTools: async (ids: string[]) => {
        const nativeToolIds = ids.filter((id) => isNativeTool(id));
        if (nativeToolIds.length > 0) {
          useNativeToolPreferencesStore.getState().setToolsEnabled(nativeToolIds, true);
        }
      },
      disableTools: async (ids: string[]) => {
        const nativeToolIds = ids.filter((id) => isNativeTool(id));
        if (nativeToolIds.length > 0) {
          useNativeToolPreferencesStore.getState().setToolsEnabled(nativeToolIds, false);
        }
      },
      resetTools: async () => {
        useNativeToolPreferencesStore.getState().resetTools();
      },
      executeToolTest: async (toolId: string, _input: unknown): Promise<ToolExecutionResult> => {
        // Tool execution for playground testing
        // Web app native tools require service worker or API integration
        const startTime = performance.now();

        return {
          success: false as const,
          error: `Tool execution not yet implemented for ${toolId}. Web app requires API integration for tool execution.`,
          durationMs: Math.round(performance.now() - startTime),
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
      createLocalRuntimeSettingsCategory(),
      {
        id: 'models',
        title: 'Models & Providers',
        description: 'Manage AI providers and enable/disable specific models.',
        keywords: ['models', 'providers', 'llm', 'embedding', 'vector'],
        icon: Layers,
        content: <ModelSelectionCategory />,
      },
      {
        id: 'logging',
        title: 'Logging & Diagnostics',
        description: 'Control browser log verbosity and redaction for debugging.',
        keywords: ['logging', 'debugging', 'console', 'diagnostics'],
        icon: FileCog,
        content: <LoggingSettingsSection logSource={logSource} runtime="browser" />,
      },
      createToolsSettingsCategory({
        operations: toolOperations,
        mcpAvailable: false,
      }),
      createAgentHubSettingsCategory({ available: false }),
      diagnosticsCategory,
      createFactoryResetSettingsCategory({
        isWebPlatform: true,
        hasStoredFolders: storedFolders.length > 0,
        onClearStoredFolders: clearStoredHandles,
        inlineFixtureSetting: {
          available: true,
          loading: false,
          checked: devInlineFixtureEnabled,
          onChange: setDevInlineFixtureEnabled,
        },
      }),
    ];
  }, [
    logSource,
    storedFolders.length,
    clearStoredHandles,
    devInlineFixtureEnabled,
    setDevInlineFixtureEnabled,
    toolOperations,
    accurateRuntimeAvailable,
  ]);

  return (
    <>
      <Helmet>
        <title>Settings - BrainStrike.ai</title>
        <meta content="Customize your application settings" name="description" />
      </Helmet>

      <SettingsLayout categories={categories} defaultCategoryId="appearance" />
    </>
  );
}
