import { isNativeTool, NATIVE_TOOL_DEFAULTS } from '@brainstrike/agent/client';
import { createSystemDiagnosticsSettingsCategory } from '@brainstrike/app-shell';
import { useRestoreAccess } from '@brainstrike/file-explorer-hooks';
import { useFileExplorerStoreContext } from '@brainstrike/file-explorer-ui';
import {
  createAppearanceSettingsCategory,
  createFactoryResetSettingsCategory,
  createTokenCountingSettingsCategory,
  createToolsSettingsCategory,
  LoggingSettingsSection,
  type LogSourceAdapter,
  ModelSelectionPage,
  type SettingsCategory,
  SettingsPageContent as SettingsLayout,
  type ToolDisplayMetadata,
  type ToolExecutionResult,
  useNativeToolPreferencesStore,
} from '@brainstrike/preferences';
import { FileCog, Layers } from 'lucide-react';
import { useMemo } from 'react';
import { Helmet } from 'react-helmet-async';
import { getWebLogBuffer } from '../../log-buffer';

/**
 * Transform NATIVE_TOOL_DEFAULTS into ToolDisplayMetadata format.
 * Native tools are always enabled by default (can be toggled in settings).
 */
function getNativeToolsAsDisplayMetadata(
  isToolEnabled: (toolId: string) => boolean
): ToolDisplayMetadata[] {
  return Object.entries(NATIVE_TOOL_DEFAULTS).map(([id, metadata]) => ({
    id,
    source: 'native' as const,
    category: metadata.category,
    loadingTier: metadata.loadingTier,
    description: getToolDescription(id),
    enabled: isToolEnabled(id),
    estimatedTokens: metadata.estimatedTokens,
    requiresApproval: metadata.requiresApproval,
  }));
}

/**
 * Get human-readable description for native tools.
 */
function getToolDescription(toolId: string): string {
  const descriptions: Record<string, string> = {
    'brainstrike.retrieveContext': 'Retrieve relevant context from indexed documents',
    'brainstrike.hybridSearch': 'Semantic + keyword search with RRF fusion',
    'brainstrike.queueStatus': 'Check embedding queue health and coverage',
    'brainstrike.packContext': 'Token-budgeted context formatting',
    'brainstrike.listEmbeddingSets': 'List available embedding collections',
    'brainstrike.createEmbeddingSet': 'Create a new embedding collection',
    'brainstrike.createSelectionScope': 'Create scoped retrieval context',
    'brainstrike.queryFileTree': 'Query directories and search files',
    'brainstrike.importFiles': 'Batch document ingestion',
    'brainstrike.systemDiagnostics': 'Database/queue/worker health diagnostics',
    'brainstrike.reembedCollection': 'Trigger re-embedding for a collection',
    'web.searchDocs': 'Search documentation',
    'web.docSummary': 'Summarize documentation',
  };
  return descriptions[toolId] ?? `Native tool: ${toolId}`;
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

  // Inline fixture state from file explorer store context
  const store = useFileExplorerStoreContext();
  const devInlineFixtureEnabled = store((s) => s.devInlineFixtureEnabled);
  const setDevInlineFixtureEnabled = store((s) => s.setDevInlineFixtureEnabled);

  const logSource = useMemo<LogSourceAdapter>(() => {
    const buffer = getWebLogBuffer();
    return {
      getInitialRecords: async () => buffer.getRecords(),
      subscribe: (handler) => buffer.subscribe(handler),
    };
  }, []);

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

  const categories = useMemo<SettingsCategory[]>(
    () => [
      createAppearanceSettingsCategory(),
      createTokenCountingSettingsCategory(),
      {
        id: 'models',
        title: 'Models & Providers',
        description: 'Manage AI providers and enable/disable specific models.',
        keywords: ['models', 'providers', 'llm', 'embedding', 'vector'],
        icon: Layers,
        render: () => <ModelSelectionCategory />,
      },
      {
        id: 'logging',
        title: 'Logging & Diagnostics',
        description: 'Control browser log verbosity and redaction for debugging.',
        keywords: ['logging', 'debugging', 'console', 'diagnostics'],
        icon: FileCog,
        render: () => <LoggingSettingsSection logSource={logSource} runtime="browser" />,
      },
      createToolsSettingsCategory({
        operations: toolOperations,
        mcpAvailable: false,
      }),
      createSystemDiagnosticsSettingsCategory(),
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
    ],
    [
      logSource,
      storedFolders.length,
      clearStoredHandles,
      devInlineFixtureEnabled,
      setDevInlineFixtureEnabled,
      toolOperations,
    ]
  );

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
