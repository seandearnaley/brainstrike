import {
  DESKTOP_NATIVE_TOOL_IDS,
  getNativeToolDescription,
  isNativeTool,
  NATIVE_TOOL_DEFAULTS,
} from '@brainstrike/agent/tool-metadata';
import { useAssistantAvailability, useHostAssistantStatusFetcher } from '@brainstrike/app-shell';
import { useAssistantThreadHost } from '@brainstrike/app-shell/assistant-thread-host-context';
import { createCostTrackingSettingsCategory } from '@brainstrike/app-shell/cost-tracking-settings';
import { createSystemDiagnosticsSettingsCategory } from '@brainstrike/app-shell/diagnostics';
import { resolvePlatformBridge } from '@brainstrike/app-shell/platform-bridge';
import { getAccurateRuntimeAvailabilityTestOverride } from '@brainstrike/app-state/automation-overrides';
import { useNativeToolPreferencesStore } from '@brainstrike/app-state/stores/native-tool-preferences-store';
import type {
  McpExtensionEnablement,
  McpHostControlRequest,
  McpHostWatchEvent,
} from '@brainstrike/assistant-contract';
import { hasDurableAssistantUsageCapability } from '@brainstrike/assistant-data';
import { useOptionalTokenCacheContext } from '@brainstrike/file-explorer-ui/indexing';
import { useFileExplorerStoreSelector } from '@brainstrike/file-explorer-ui/shell';
import { configureModelRuntimeServices } from '@brainstrike/settings-ui/settings/models/model-runtime-services';
import {
  ModelCatalogHeaderActions,
  ModelSelectionPage,
} from '@brainstrike/settings-ui/settings/models/model-selection-page';
import { createProvidersSettingsCategory } from '@brainstrike/settings-ui/settings/providers/providers-settings-category';
import { createNotificationSettingsCategory } from '@brainstrike/settings-ui/settings/system/notification-settings-category';
import { createSkillsSettingsCategory } from '@brainstrike/settings-ui/settings/system/skills-settings-category';
import { createWorkspaceInstructionsSettingsCategory } from '@brainstrike/settings-ui/settings/system/workspace-instructions-settings-category';
import {
  createToolsSettingsCategory,
  type McpCompleteRequest,
  type McpGetPromptRequest,
  type McpReadResourceRequest,
  type ToolDisplayMetadata,
} from '@brainstrike/settings-ui/settings/tools/index';
import {
  createAppearanceSettingsCategory,
  createAssistantMemorySettingsCategory,
  createFactoryResetSettingsCategory,
  createHooksSettingsCategory,
  createLocalRuntimeSettingsCategory,
  createPermissionSettingsCategory,
  createSearchIndexingSettingsCategory,
  createSubagentPersonasSettingsCategory,
  createTokenCountingSettingsCategoryWithRuntimeSupport,
  createWorkspaceSettingsCategory,
  type HookReviewRoot,
} from '@brainstrike/settings-ui/settings-category-factories';
import {
  type SettingsCategory,
  SettingsPageContent as SettingsLayout,
} from '@brainstrike/settings-ui/settings-page-content';
import { FileCog, Layers } from 'lucide-react';
import { useMemo } from 'react';
import {
  type DesktopHostMcpSettings,
  resolveDesktopHostMcpSettings,
  resolveDesktopMcpContent,
} from '../../host-mcp-settings';
import { DesktopLoggingSettings } from './logging-settings';
import { useWorktreeSettings } from './use-worktree-settings';

const refuseWithoutHost = (): Promise<never> =>
  Promise.reject(new Error('The agent host provider reads are unavailable.'));

configureModelRuntimeServices({
  downloadEmbeddingModel: async (modelId, options) => {
    const { SimpleEmbeddingService } = await import('@brainstrike/embeddings/service');
    const service = new SimpleEmbeddingService();
    await service.downloadModel(modelId, options);
  },
});

/**
 * Transform the desktop-owned native tools into ToolDisplayMetadata format.
 * Mastra skill tools have their own preferences and are not desktop toggles.
 */
function getNativeToolsAsDisplayMetadata(
  isToolEnabled: (toolId: string) => boolean
): ToolDisplayMetadata[] {
  return DESKTOP_NATIVE_TOOL_IDS.map((id) => {
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

/** The host refuses a change it cannot save with its own message, which Settings shows. */
async function changeMcpToolPreferences(
  mcpSettings: DesktopHostMcpSettings | null,
  ids: string[],
  enabled: boolean
): Promise<void> {
  if (!mcpSettings) {
    throw new Error('MCP tool preferences need the desktop agent host');
  }
  await mcpSettings.request('mcp/tools/set', { enabled, toolIds: ids });
}

export default function SettingsPageContent() {
  // Desktop reads provider facts only from its host; a missing host is an error, not Main.
  const hostProviders = useAssistantThreadHost()?.providers;
  const assistantAvailability = useAssistantAvailability(
    useHostAssistantStatusFetcher() ?? refuseWithoutHost
  );
  const worktreeSettings = useWorktreeSettings();
  // Inline fixture state from file explorer store context (shared with FileExplorerLeftPanel)
  const tokenCache = useOptionalTokenCacheContext();
  const devInlineFixtureEnabled = useFileExplorerStoreSelector((s) => s.devInlineFixtureEnabled);
  const setDevInlineFixtureEnabled = useFileExplorerStoreSelector(
    (s) => s.setDevInlineFixtureEnabled
  );
  // Live mounted workspace roots (reactive to mount/unmount via the zustand
  // store) power the Hooks trust-review panel. Keyed by durable adapter rootId
  // in sidebar order; absolute paths feed the desktop review IPC.
  const activeRootIds = useFileExplorerStoreSelector((s) => s.activeRootIds);
  const rootDescriptors = useFileExplorerStoreSelector((s) => s.rootDescriptors);
  const hookReviewRoots = useMemo<readonly HookReviewRoot[]>(() => {
    const roots: HookReviewRoot[] = [];
    for (const rootId of activeRootIds) {
      const descriptor = rootDescriptors[rootId];
      if (!descriptor) {
        continue;
      }
      roots.push({
        absPath: descriptor.path,
        displayName: descriptor.displayName,
        rootId: descriptor.rootId,
      });
    }
    return roots;
  }, [activeRootIds, rootDescriptors]);
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
  // Shell reveal is injected, not reached for: settings-ui stays platform
  // agnostic and simply renders no Open-folder affordance when the desktop
  // bridge is absent or malformed (resolvePlatformBridge returns null).
  // The `{ ok, error }` result is normalized exactly as
  // context-action-registry does, so a failed reveal can be shown rather than
  // vanishing.
  const revealEnvFile = useMemo(() => {
    const bridge = resolvePlatformBridge();
    if (!bridge) {
      return;
    }
    return async (absolutePath: string) => {
      const result = await bridge.showItemInFolder(absolutePath);
      return result.ok ? { ok: true } : { error: result.error ?? 'Reveal failed', ok: false };
    };
  }, []);
  const apiKeyStatus = useMemo(() => {
    // Every non-loading availability state may carry deprecated-env rename
    // reports (BST-1361); the Credential Inventory renders them per row.
    const deprecated =
      assistantAvailability.state !== 'loading' &&
      assistantAvailability.deprecatedEnvVars &&
      assistantAvailability.deprecatedEnvVars.length > 0
        ? { statusDeprecatedEnvVars: assistantAvailability.deprecatedEnvVars }
        : {};
    if (assistantAvailability.state === 'enabled') {
      return {
        ...deprecated,
        statusProviderKeySources: assistantAvailability.providerKeySources ?? [],
      };
    }
    if (assistantAvailability.state === 'error') {
      const failures = assistantAvailability.envFileFailures?.map(({ message }) => message) ?? [];
      return failures.length > 0 ? { ...deprecated, statusError: failures.join(' ') } : deprecated;
    }
    return deprecated;
  }, [assistantAvailability]);
  const assistantProviderKeySources =
    assistantAvailability.state === 'enabled'
      ? assistantAvailability.providerKeySources
      : undefined;

  // The agent host owns the MCP config, extension dials, tool preferences,
  // server status and lifecycle control; a window without the host has none.
  const mcpSettings = useMemo(() => resolveDesktopHostMcpSettings(), []);
  // BST-1585: user-initiated MCP content browsing comes from the agent host
  // (BST-1930 c5d); web has none, so the Settings affordance is absent.
  const mcpContent = useMemo(() => resolveDesktopMcpContent(), []);
  // Create non-executing tool catalog and MCP configuration operations.
  const toolOperations = useMemo(() => {
    return {
      ...(mcpContent && {
        completeMcpContent: async (request: McpCompleteRequest) =>
          await mcpContent.complete(request),
        getMcpPrompt: async (request: McpGetPromptRequest) => await mcpContent.getPrompt(request),
        readMcpResource: async (request: McpReadResourceRequest) =>
          await mcpContent.readResource(request),
      }),
      ...(mcpSettings && {
        controlMcpServer: async (request: McpHostControlRequest) =>
          await mcpSettings.request('mcp/server/control', request),
        getMcpExtensionPreferences: async () =>
          await mcpSettings.request('mcp/extensions/read', {}),
        getMcpServerStatus: async () => await mcpSettings.request('mcp/status/read', {}),
        reloadToolPreferences: async () => {
          await mcpSettings.request('mcp/tools/reload', {});
        },
        setMcpExtensionPreferences: async (preferences: McpExtensionEnablement) =>
          await mcpSettings.request('mcp/extensions/set', preferences),
        subscribeMcpExtensionPreferences: (
          listener: (preferences: McpExtensionEnablement) => void
        ) =>
          mcpSettings.subscribe((event) => {
            if (event.type === 'extensions') {
              listener(event.extensions);
            }
          }),
        subscribeMcpServerStatus: (listener: (event: McpHostWatchEvent) => void) =>
          mcpSettings.subscribe((event) => {
            if (event.type === 'status') {
              listener(event.status);
            }
          }),
      }),
      disableTools: async (ids: string[]) => {
        const nativeToolIds = ids.filter((id) => isNativeTool(id));
        const mcpToolIds = ids.filter((id) => !isNativeTool(id));

        if (nativeToolIds.length > 0) {
          useNativeToolPreferencesStore.getState().setToolsEnabled(nativeToolIds, false);
        }
        if (mcpToolIds.length > 0) {
          await changeMcpToolPreferences(mcpSettings, mcpToolIds, false);
        }
      },
      enableTools: async (ids: string[]) => {
        const nativeToolIds = ids.filter((id) => isNativeTool(id));
        const mcpToolIds = ids.filter((id) => !isNativeTool(id));

        if (nativeToolIds.length > 0) {
          useNativeToolPreferencesStore.getState().setToolsEnabled(nativeToolIds, true);
        }
        if (mcpToolIds.length > 0) {
          await changeMcpToolPreferences(mcpSettings, mcpToolIds, true);
        }
      },
      getStats: async () => {
        const { isToolEnabled } = useNativeToolPreferencesStore.getState();
        const nativeTools = getNativeToolsAsDisplayMetadata(isToolEnabled);
        const mcpStats = await mcpSettings?.request('mcp/tools/stats', {});

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
          // BST-1615: an unreadable tool-preferences file is reported here so
          // Settings says so, rather than showing a silently reset tool list.
          ...(mcpStats?.preferencesFault ? { preferencesFault: mcpStats.preferencesFault } : {}),
          total: nativeCount + mcpCount,
        };
      },
      getTools: async (): Promise<ToolDisplayMetadata[]> => {
        // Start with native tools
        const { isToolEnabled } = useNativeToolPreferencesStore.getState();
        const nativeTools = getNativeToolsAsDisplayMetadata(isToolEnabled);

        // Add MCP tools if available
        const mcpToolsData = await mcpSettings?.request('mcp/tools/list', {});
        const mcpTools: ToolDisplayMetadata[] = [];

        if (mcpToolsData) {
          for (const [serverName, serverTools] of Object.entries(mcpToolsData)) {
            for (const tool of serverTools) {
              if (tool.serverName !== serverName) {
                throw new Error(
                  `MCP tool projection identity mismatch: group "${serverName}" contains server "${tool.serverName}"`
                );
              }
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
        // The native picker hands the chosen file to the host, which selects it,
        // reloads it and announces the new config and tools.
        await window.mcp?.selectPath?.();
      },
      refreshMcpServers: async () => {
        await mcpSettings?.request('mcp/tools/list', {});
      },
      resetMcpConfig: async () => {
        // Back to the profile's default config path; the host reloads and announces it.
        await mcpSettings?.request('mcp/config/path/set', { path: null });
      },
      resetTools: async () => {
        useNativeToolPreferencesStore.getState().resetTools();
        await mcpSettings?.request('mcp/tools/reset', {});
      },
      subscribeMcpConfig: (
        listener: (info: { error?: string; exists: boolean; path: string }) => void
      ) => {
        if (!mcpSettings) {
          throw new Error('MCP settings need the desktop agent host');
        }
        return mcpSettings.subscribe((event) => {
          if (event.type === 'config') {
            listener(event.config);
          }
        });
      },
      subscribeMcpTools: (listener: () => void) => {
        if (!mcpSettings) {
          throw new Error('MCP settings need the desktop agent host');
        }
        return mcpSettings.subscribe((event) => {
          if (event.type === 'tools') {
            listener();
          }
        });
      },
      ...(mcpSettings && {
        getMcpConfigPath: async () => (await mcpSettings.request('mcp/config/path', {})).path,
        readMcpConfigText: async () => await mcpSettings.request('mcp/config/read', {}),
        setMcpConfigPath: async (configPath: string | null) => {
          await mcpSettings.request('mcp/config/path/set', { path: configPath });
        },
        writeMcpConfigText: async (content: string) =>
          await mcpSettings.request('mcp/config/write', { content }),
      }),
      createSampleConfig: async () => {
        if (!mcpSettings) {
          return { error: 'MCP settings need the desktop agent host', path: '', success: false };
        }
        return await mcpSettings.request('mcp/config/sample', {});
      },
      getMcpConfigInfo: async () => {
        const config = await mcpSettings?.request('mcp/config/status', {});
        if (!config) {
          return null;
        }
        return {
          exists: config.exists,
          path: config.path,
          ...(config.error ? { error: config.error } : {}),
        };
      },
    };
  }, [mcpContent, mcpSettings]);

  const categories = useMemo<SettingsCategory[]>(() => {
    const diagnosticsCategory = createSystemDiagnosticsSettingsCategory();

    return [
      createAppearanceSettingsCategory(),
      createSearchIndexingSettingsCategory(window.indexSearch),
      createTokenCountingSettingsCategoryWithRuntimeSupport({ accurateRuntimeAvailable }),
      createCostTrackingSettingsCategory(),
      createLocalRuntimeSettingsCategory(),
      createProvidersSettingsCategory({
        ...apiKeyStatus,
        ...(revealEnvFile ? { onRevealPath: revealEnvFile } : {}),
        verifyProvider: (providerId: string) =>
          hostProviders ? hostProviders.verifyProvider(providerId) : refuseWithoutHost(),
      }),
      {
        content: <ModelSelectionPage />,
        description:
          'Browse every catalogued model, manage local downloads, and set the model cache directory.',
        headerActions: <ModelCatalogHeaderActions />,
        icon: Layers,
        id: 'embedding-models',
        keywords: ['embeddings', 'models', 'catalog', 'vector', 'llm', 'download', 'cache'],
        layout: 'workspace',
        title: 'Model Catalog',
      },
      createAssistantMemorySettingsCategory({
        assistantMemoryBackendAvailable: hasDurableAssistantUsageCapability(),
        ...(assistantProviderKeySources ? { providerKeySources: assistantProviderKeySources } : {}),
      }),
      {
        content: <DesktopLoggingSettings />,
        description: 'Control renderer log verbosity and manage file logging for debugging.',
        icon: FileCog,
        id: 'logging',
        keywords: ['logging', 'diagnostics', 'debugging', 'log file'],
        title: 'Logging & Diagnostics',
      },
      createToolsSettingsCategory({
        mcpAvailable: mcpSettings !== null,
        operations: toolOperations,
      }),
      createPermissionSettingsCategory(),
      createSubagentPersonasSettingsCategory(),
      createSkillsSettingsCategory(),
      createHooksSettingsCategory({ roots: hookReviewRoots }),
      createWorkspaceInstructionsSettingsCategory(),
      createWorkspaceSettingsCategory({
        onSave: worktreeSettings.save,
        settings: worktreeSettings.settings,
        status: worktreeSettings.status,
      }),
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
    apiKeyStatus,
    assistantProviderKeySources,
    devInlineFixtureEnabled,
    hookReviewRoots,
    hostProviders,
    mcpSettings,
    revealEnvFile,
    setDevInlineFixtureEnabled,
    toolOperations,
    worktreeSettings.save,
    worktreeSettings.settings,
    worktreeSettings.status,
  ]);

  return (
    <>
      <title>BrainStrike Desktop - Settings</title>
      <meta content="BrainStrike Desktop Settings" name="description" />

      <SettingsLayout categories={categories} defaultCategoryId="appearance" />
    </>
  );
}
