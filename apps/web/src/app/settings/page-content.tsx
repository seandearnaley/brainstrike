import {
  getNativeToolDescription,
  isNativeTool,
  NATIVE_TOOL_DEFAULTS,
  WEB_NATIVE_TOOL_IDS,
} from '@brainstrike/agent/tool-metadata';
import { verifyProviderCredential } from '@brainstrike/app-shell';
import { createCostTrackingSettingsCategory } from '@brainstrike/app-shell/cost-tracking-settings';
import {
  createSystemDiagnosticsSettingsCategory,
  useDiagnosticSinkHealthStore,
  useDiagnosticsPurge,
  useDurableLogSource,
} from '@brainstrike/app-shell/diagnostics';
import { getAccurateRuntimeAvailabilityTestOverride } from '@brainstrike/app-state/automation-overrides';
import { useNativeToolPreferencesStore } from '@brainstrike/app-state/stores/native-tool-preferences-store';
import { hasDurableAssistantUsageCapability } from '@brainstrike/assistant-data';
import { useRestoreAccess } from '@brainstrike/file-explorer-hooks';
import { useOptionalTokenCacheContext } from '@brainstrike/file-explorer-ui/indexing';
import { useFileExplorerStoreSelector } from '@brainstrike/file-explorer-ui/shell';
import { configureModelRuntimeServices } from '@brainstrike/settings-ui/settings/models/model-runtime-services';
import {
  ModelCatalogHeaderActions,
  ModelSelectionPage,
} from '@brainstrike/settings-ui/settings/models/model-selection-page';
import { createProvidersSettingsCategory } from '@brainstrike/settings-ui/settings/providers/providers-settings-category';
import {
  LoggingSettingsSection,
  type LogSourceAdapter,
} from '@brainstrike/settings-ui/settings/system/logging-settings-section';
import { createNotificationSettingsCategory } from '@brainstrike/settings-ui/settings/system/notification-settings-category';
import {
  createToolsSettingsCategory,
  type ToolDisplayMetadata,
} from '@brainstrike/settings-ui/settings/tools/index';
import {
  createAppearanceSettingsCategory,
  createAssistantMemorySettingsCategory,
  createFactoryResetSettingsCategory,
  createLocalRuntimeSettingsCategory,
  createPermissionSettingsCategory,
  createSearchIndexingSettingsCategory,
  createSubagentPersonasSettingsCategory,
  createTokenCountingSettingsCategoryWithRuntimeSupport,
} from '@brainstrike/settings-ui/settings-category-factories';
import {
  type SettingsCategory,
  SettingsPageContent as SettingsLayout,
} from '@brainstrike/settings-ui/settings-page-content';
import { FileCog, Layers } from 'lucide-react';
import { useMemo } from 'react';
import { getWebLogBuffer } from '../../log-buffer';

configureModelRuntimeServices({
  downloadEmbeddingModel: async (modelId, options) => {
    const { SimpleEmbeddingService } = await import('@brainstrike/embeddings/service');
    const service = new SimpleEmbeddingService();
    try {
      await service.downloadModel(modelId, options);
    } finally {
      await service.dispose();
    }
  },
});

/**
 * Transform NATIVE_TOOL_DEFAULTS into ToolDisplayMetadata format.
 * Native tools are always enabled by default (can be toggled in settings).
 */
function getNativeToolsAsDisplayMetadata(
  isToolEnabled: (toolId: string) => boolean
): ToolDisplayMetadata[] {
  return WEB_NATIVE_TOOL_IDS.map((id) => {
    const metadata = NATIVE_TOOL_DEFAULTS[id];
    return {
      category: metadata.category,
      description: getToolDescription(id),
      enabled: isToolEnabled(id),
      estimatedTokens: metadata.estimatedTokens,
      id,
      loadingTier: metadata.loadingTier,
      requiresApproval: metadata.requiresApproval,
      source: 'native' as const,
    };
  });
}

/**
 * Get human-readable description for native tools.
 */
function getToolDescription(toolId: string): string {
  return getNativeToolDescription(toolId) ?? `Native tool: ${toolId}`;
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

  const durableLogSource = useDurableLogSource();
  const onPurgeNow = useDiagnosticsPurge();
  const sinkHealthReason = useDiagnosticSinkHealthStore((state) => state.disabledReason);

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
      disableTools: async (ids: string[]) => {
        const nativeToolIds = ids.filter((id) => isNativeTool(id));
        if (nativeToolIds.length > 0) {
          useNativeToolPreferencesStore.getState().setToolsEnabled(nativeToolIds, false);
        }
      },
      enableTools: async (ids: string[]) => {
        const nativeToolIds = ids.filter((id) => isNativeTool(id));
        if (nativeToolIds.length > 0) {
          useNativeToolPreferencesStore.getState().setToolsEnabled(nativeToolIds, true);
        }
      },
      getStats: async () => {
        const { isToolEnabled } = useNativeToolPreferencesStore.getState();
        const nativeTools = getNativeToolsAsDisplayMetadata(isToolEnabled);
        const nativeCount = nativeTools.length;
        const nativeEnabled = nativeTools.filter((t) => t.enabled).length;

        return {
          byCategory: {
            action: nativeTools.filter((t) => t.category === 'action').length,
            analysis: nativeTools.filter((t) => t.category === 'analysis').length,
            configuration: nativeTools.filter((t) => t.category === 'configuration').length,
            retrieval: nativeTools.filter((t) => t.category === 'retrieval').length,
            validation: nativeTools.filter((t) => t.category === 'validation').length,
          },
          bySource: { mcp: 0, native: nativeCount },
          disabled: nativeCount - nativeEnabled,
          enabled: nativeEnabled,
          mcpServers: 0,
          total: nativeCount,
        };
      },
      getTools: async (): Promise<ToolDisplayMetadata[]> => {
        // Return native tools - web app doesn't have MCP
        const { isToolEnabled } = useNativeToolPreferencesStore.getState();
        return getNativeToolsAsDisplayMetadata(isToolEnabled);
      },
      resetTools: async () => {
        useNativeToolPreferencesStore.getState().resetTools();
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
      // Web has no `window.secrets` bridge, so the hub renders provider status
      // read-only ("configured via server environment") with no editors. The
      // capability check lives inside the component — never a platform test.
      createProvidersSettingsCategory({ verifyProvider: verifyProviderCredential }),
      {
        content: <ModelSelectionPage />,
        description: 'Browse every catalogued model and enable the ones you want.',
        headerActions: <ModelCatalogHeaderActions />,
        icon: Layers,
        id: 'models',
        keywords: ['models', 'catalog', 'llm', 'embedding', 'vector'],
        layout: 'workspace',
        title: 'Model Catalog',
      },
      createAssistantMemorySettingsCategory({
        assistantMemoryBackendAvailable: hasDurableAssistantUsageCapability(),
      }),
      {
        content: (
          <LoggingSettingsSection
            logSource={logSource}
            runtime="browser"
            sinkHealthReason={sinkHealthReason}
            {...(durableLogSource === undefined
              ? {}
              : {
                  durableLogSource,
                  onExportDurableNdjson: () => durableLogSource.exportNdjson(),
                })}
            {...(onPurgeNow === undefined ? {} : { onPurgeNow })}
          />
        ),
        description: 'Control browser log verbosity and redaction for debugging.',
        icon: FileCog,
        id: 'logging',
        keywords: ['logging', 'debugging', 'console', 'diagnostics'],
        title: 'Logging & Diagnostics',
      },
      createToolsSettingsCategory({
        mcpAvailable: false,
        operations: toolOperations,
      }),
      createPermissionSettingsCategory(),
      createSubagentPersonasSettingsCategory(),
      createNotificationSettingsCategory(),
      diagnosticsCategory,
      createFactoryResetSettingsCategory({
        hasStoredFolders: storedFolders.length > 0,
        inlineFixtureSetting: {
          available: true,
          checked: devInlineFixtureEnabled,
          loading: false,
          onChange: setDevInlineFixtureEnabled,
        },
        isWebPlatform: true,
        onClearStoredFolders: clearStoredHandles,
      }),
    ];
  }, [
    logSource,
    durableLogSource,
    onPurgeNow,
    sinkHealthReason,
    storedFolders.length,
    clearStoredHandles,
    devInlineFixtureEnabled,
    setDevInlineFixtureEnabled,
    toolOperations,
    accurateRuntimeAvailable,
  ]);

  // No document metadata here: `useDocumentTitle` writes the Settings title
  // whenever the settings dialog is open (see its doc comment for why exactly
  // one writer exists).
  return <SettingsLayout categories={categories} defaultCategoryId="appearance" />;
}
