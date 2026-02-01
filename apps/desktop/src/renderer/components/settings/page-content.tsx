import { NATIVE_TOOL_DEFAULTS } from '@brainstrike/agent/client';
import { createSystemDiagnosticsSettingsCategory } from '@brainstrike/app-shell';
import { useFileExplorerStoreContext } from '@brainstrike/file-explorer-ui';
import {
  createApiKeysSettingsCategory,
  createAppearanceSettingsCategory,
  createFactoryResetSettingsCategory,
  createTokenCountingSettingsCategory,
  createToolsSettingsCategory,
  ModelSelectionPage,
  type SettingsCategory,
  SettingsPageContent as SettingsLayout,
  type ToolDisplayMetadata,
} from '@brainstrike/preferences';
import { FileCog, Layers } from 'lucide-react';
import { useMemo } from 'react';
import { DesktopLoggingSettings } from './logging-settings';

/**
 * Transform NATIVE_TOOL_DEFAULTS into ToolDisplayMetadata format.
 * Native tools are always enabled by default (can be toggled in settings).
 */
function getNativeToolsAsDisplayMetadata(): ToolDisplayMetadata[] {
  return Object.entries(NATIVE_TOOL_DEFAULTS).map(([id, metadata]) => ({
    id,
    source: 'native' as const,
    category: metadata.category,
    loadingTier: metadata.loadingTier,
    description: getToolDescription(id),
    enabled: true, // Native tools enabled by default
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

function EmbeddingModelsCategory() {
  return <ModelSelectionPage />;
}

export default function SettingsPageContent() {
  // Inline fixture state from file explorer store context (shared with FileExplorerLeftPanel)
  const store = useFileExplorerStoreContext();
  const devInlineFixtureEnabled = store((s) => s.devInlineFixtureEnabled);
  const setDevInlineFixtureEnabled = store((s) => s.setDevInlineFixtureEnabled);

  // Create tool operations that integrate with window.mcp and window.tools APIs
  const toolOperations = useMemo(
    () => ({
      getTools: async (): Promise<ToolDisplayMetadata[]> => {
        // Start with native tools
        const nativeTools = getNativeToolsAsDisplayMetadata();

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
                id: tool.id,
                source: 'mcp',
                category: 'action',
                loadingTier: 'conditional',
                description: tool.description ?? '',
                enabled: tool.enabled,
                serverName,
                estimatedTokens: 100,
                requiresApproval: false,
                inputSchema: tool.inputSchema,
              });
            }
          }
        }

        return [...nativeTools, ...mcpTools];
      },
      getStats: async () => {
        const nativeTools = getNativeToolsAsDisplayMetadata();
        const mcpStats = await window.mcp?.getToolStats?.();

        const nativeCount = nativeTools.length;
        const mcpCount = mcpStats?.total ?? 0;
        const nativeEnabled = nativeTools.filter((t) => t.enabled).length;
        const mcpEnabled = mcpStats?.enabled ?? 0;

        // Calculate category counts from native tools
        const byCategory = {
          retrieval: nativeTools.filter((t) => t.category === 'retrieval').length,
          action: nativeTools.filter((t) => t.category === 'action').length + mcpCount, // MCP tools default to action
          analysis: nativeTools.filter((t) => t.category === 'analysis').length,
          configuration: nativeTools.filter((t) => t.category === 'configuration').length,
          validation: nativeTools.filter((t) => t.category === 'validation').length,
        };

        return {
          total: nativeCount + mcpCount,
          enabled: nativeEnabled + mcpEnabled,
          disabled: nativeCount + mcpCount - (nativeEnabled + mcpEnabled),
          bySource: { native: nativeCount, mcp: mcpCount },
          byCategory,
          mcpServers: mcpStats?.servers ?? 0,
        };
      },
      enableTools: async (ids: string[]) => {
        await window.mcp?.enableTools?.(ids);
      },
      disableTools: async (ids: string[]) => {
        await window.mcp?.disableTools?.(ids);
      },
      resetTools: async () => {
        await window.mcp?.resetTools?.();
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
      refreshMcpServers: async () => {
        // Reload tools list to refresh server status
        await window.mcp?.listTools?.();
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
      resetMcpConfig: async () => {
        // Reset to default config path
        await window.mcp?.setPath?.(null);
        // Refresh tools list to pick up changes
        await window.mcp?.listTools?.();
      },
      getMcpConfigInfo: async () => {
        // Get current MCP config info
        const config = await window.mcp?.getConfig?.();
        if (!config) {
          return null;
        }
        return {
          path: config.path,
          exists: config.exists,
        };
      },
      executeToolTest: async (toolId: string, _input: unknown) => {
        // Tool execution for playground testing
        // Future: Wire to IPC bridge for native tools, MCP protocol for MCP tools
        const startTime = performance.now();
        const isNative = !toolId.startsWith('mcp__');

        return {
          success: false,
          error: isNative
            ? `Native tool execution not yet implemented. The ${toolId} tool requires main process integration.`
            : `MCP tool execution not yet implemented. The ${toolId} tool requires MCP protocol integration.`,
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
      createApiKeysSettingsCategory(),
      {
        id: 'embedding-models',
        title: 'Models & Providers',
        description: 'Choose chat and embedding models, manage downloads, and configure providers.',
        keywords: ['embeddings', 'models', 'providers', 'vector', 'llm', 'download'],
        icon: Layers,
        render: () => <EmbeddingModelsCategory />,
      },
      {
        id: 'logging',
        title: 'Logging & Diagnostics',
        description: 'Control renderer log verbosity and manage file logging for debugging.',
        keywords: ['logging', 'diagnostics', 'debugging', 'log file'],
        icon: FileCog,
        render: () => <DesktopLoggingSettings />,
      },
      createToolsSettingsCategory({
        operations: toolOperations,
        mcpAvailable: true,
      }),
      createSystemDiagnosticsSettingsCategory(),
      createFactoryResetSettingsCategory({
        isWebPlatform: false,
        inlineFixtureSetting: {
          available: true,
          loading: false,
          checked: devInlineFixtureEnabled,
          onChange: setDevInlineFixtureEnabled,
        },
      }),
    ],
    [devInlineFixtureEnabled, setDevInlineFixtureEnabled, toolOperations]
  );

  return (
    <>
      <title>BrainStrike Desktop - Settings</title>
      <meta content="BrainStrike Desktop Settings" name="description" />

      <SettingsLayout categories={categories} defaultCategoryId="appearance" />
    </>
  );
}
