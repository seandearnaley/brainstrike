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
import { createSelfImprovementSignalSettingsCategory } from '@brainstrike/settings-ui/settings/system/self-improvement-signal-settings-category';
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
import { DESKTOP_IPC_CHANNELS } from '../../../platform/desktop-ipc-channels';
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

async function changeMcpToolPreferences(ids: string[], enabled: boolean): Promise<void> {
  const mcp = window.mcp;
  try {
    if (enabled) {
      await mcp?.enableTools?.(ids);
    } else {
      await mcp?.disableTools?.(ids);
    }
  } catch (error) {
    // Strip only this channel's exact transport wrapper. Fault attribution stays
    // with the caller's pre-action stats, never a racy post-failure stats read.
    if (error instanceof Error) {
      const channel = enabled
        ? DESKTOP_IPC_CHANNELS.mcp.toolsEnable
        : DESKTOP_IPC_CHANNELS.mcp.toolsDisable;
      const prefix = `Error invoking remote method '${channel}': Error: `;
      if (error.message.startsWith(prefix)) {
        throw new Error(error.message.slice(prefix.length), { cause: error });
      }
    }
    throw error;
  }
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

  // Create non-executing tool catalog and MCP configuration operations.
  const toolOperations = useMemo(() => {
    const onServerStatusUpdated = window.mcp?.onServerStatusUpdated;
    return {
      // BST-1585: user-initiated MCP content browsing is capability-gated on
      // the bridge methods; web omits them, so the Settings affordance is absent.
      ...(window.mcp?.complete && {
        completeMcpContent: async (request: McpCompleteRequest) =>
          await window.mcp.complete(request),
      }),
      ...(window.mcp?.controlServer && {
        controlMcpServer: async (request: McpHostControlRequest) =>
          await window.mcp.controlServer(request),
      }),
      ...(window.mcp?.getExtensionPreferences && {
        getMcpExtensionPreferences: async () => await window.mcp.getExtensionPreferences(),
      }),
      ...(window.mcp?.getPrompt && {
        getMcpPrompt: async (request: McpGetPromptRequest) => await window.mcp.getPrompt(request),
      }),
      ...(window.mcp?.setExtensionPreferences && {
        setMcpExtensionPreferences: async (preferences: McpExtensionEnablement) =>
          await window.mcp.setExtensionPreferences(preferences),
      }),
      ...(window.mcp?.onExtensionPreferencesUpdated && {
        subscribeMcpExtensionPreferences: (
          listener: (preferences: McpExtensionEnablement) => void
        ) => window.mcp.onExtensionPreferencesUpdated(listener),
      }),
      ...(window.mcp?.readResource && {
        readMcpResource: async (request: McpReadResourceRequest) =>
          await window.mcp.readResource(request),
      }),
      ...(window.mcp?.reloadToolPreferences && {
        reloadToolPreferences: async () => await window.mcp.reloadToolPreferences(),
      }),
      disableTools: async (ids: string[]) => {
        const nativeToolIds = ids.filter((id) => isNativeTool(id));
        const mcpToolIds = ids.filter((id) => !isNativeTool(id));

        if (nativeToolIds.length > 0) {
          useNativeToolPreferencesStore.getState().setToolsEnabled(nativeToolIds, false);
        }
        if (mcpToolIds.length > 0) {
          await changeMcpToolPreferences(mcpToolIds, false);
        }
      },
      enableTools: async (ids: string[]) => {
        const nativeToolIds = ids.filter((id) => isNativeTool(id));
        const mcpToolIds = ids.filter((id) => !isNativeTool(id));

        if (nativeToolIds.length > 0) {
          useNativeToolPreferencesStore.getState().setToolsEnabled(nativeToolIds, true);
        }
        if (mcpToolIds.length > 0) {
          await changeMcpToolPreferences(mcpToolIds, true);
        }
      },
      getMcpServerStatus: async () => {
        const getServerStatusSnapshot = window.mcp?.getServerStatusSnapshot;
        if (!getServerStatusSnapshot) {
          throw new Error('MCP bridge is missing getServerStatusSnapshot');
        }
        return await getServerStatusSnapshot();
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
        const mcpToolsData = await window.mcp?.listTools?.();
        const mcpTools: ToolDisplayMetadata[] = [];

        if (mcpToolsData) {
          for (const [serverName, serverTools] of Object.entries(mcpToolsData)) {
            for (const tool of serverTools as Array<{
              id: string;
              description?: string;
              enabled: boolean;
              inputSchema?: unknown;
              serverName: string;
            }>) {
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
      subscribeMcpConfig: (
        listener: (info: { error?: string; exists: boolean; path: string }) => void
      ) => {
        const onConfigUpdated = window.mcp?.onConfigUpdated;
        if (!onConfigUpdated) {
          throw new Error('MCP bridge is missing onConfigUpdated');
        }
        return onConfigUpdated(listener);
      },
      ...(onServerStatusUpdated && {
        subscribeMcpServerStatus: (listener: (event: McpHostWatchEvent) => void) =>
          onServerStatusUpdated(listener),
      }),
      subscribeMcpTools: (listener: () => void) => {
        const onToolsUpdated = window.mcp?.onToolsUpdated;
        if (!onToolsUpdated) {
          throw new Error('MCP bridge is missing onToolsUpdated');
        }
        return onToolsUpdated(() => listener());
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
    };
  }, []);

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
        mcpAvailable: true,
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
      createSelfImprovementSignalSettingsCategory(),
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
