import {
  type McpExtensionEnablement,
  type McpHostSnapshot,
  type McpHostWatchEvent,
  type McpToolPreferencesFault,
  parseConfiguredMcpServerId,
} from '@brainstrike/assistant-contract';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const setToolsEnabledMock = vi.hoisted(() => vi.fn());
const resetToolsMock = vi.hoisted(() => vi.fn());
const createToolsSettingsCategoryMock = vi.hoisted(() => vi.fn());
const createTokenCountingSettingsCategoryMock = vi.hoisted(() => vi.fn());
const createHooksSettingsCategoryMock = vi.hoisted(() => vi.fn());
const createAssistantMemorySettingsCategoryMock = vi.hoisted(() => vi.fn());
const modelSelectionPageMock = vi.hoisted(() =>
  vi.fn(() => <div data-testid="model-selection-page" />)
);
const assistantAvailability = vi.hoisted(
  (): {
    current:
      | { state: 'loading' }
      | {
          providerKeySources: readonly [
            { envVar: 'OPENAI_API_KEY'; provider: 'openai'; source: 'env' },
          ];
          providers: readonly ['openai', 'local'];
          state: 'enabled';
        };
  } => ({
    current: { state: 'loading' },
  })
);

interface FileExplorerMockState {
  activeRootIds: string[];
  devInlineFixtureEnabled: boolean;
  rootDescriptors: Record<string, { displayName: string; path: string; rootId: string }>;
  setDevInlineFixtureEnabled: () => void;
}

const fileExplorerMockState = vi.hoisted((): { current: FileExplorerMockState } => ({
  current: {
    activeRootIds: [],
    devInlineFixtureEnabled: true,
    rootDescriptors: {},
    setDevInlineFixtureEnabled: () => {},
  },
}));

interface CapturedToolsOperations {
  completeMcpContent?: (request: unknown) => Promise<unknown>;
  createSampleConfig: () => Promise<{ error?: string; path: string; success: boolean }>;
  disableTools: (ids: string[]) => Promise<void>;
  enableTools: (ids: string[]) => Promise<void>;
  getMcpConfigInfo: () => Promise<{ error?: string; exists: boolean; path: string } | null>;
  getMcpConfigPath?: () => Promise<string>;
  getMcpExtensionPreferences?: () => Promise<McpExtensionEnablement>;
  getMcpPrompt?: (request: unknown) => Promise<unknown>;
  getMcpServerStatus: () => Promise<McpHostSnapshot>;
  getStats: () => Promise<{
    byCategory: Record<string, number>;
    bySource: { mcp: number; native: number };
    disabled: number;
    enabled: number;
    mcpServers: number;
    total: number;
  }>;
  getTools: () => Promise<Array<{ id: string; source: string }>>;
  openMcpConfig: () => Promise<void>;
  readMcpConfigText?: () => Promise<{ content: string; path: string }>;
  readMcpResource?: (request: unknown) => Promise<unknown>;
  refreshMcpServers: () => Promise<void>;
  reloadToolPreferences?: () => Promise<void>;
  resetMcpConfig: () => Promise<void>;
  resetTools: () => Promise<void>;
  setMcpConfigPath?: (configPath: string | null) => Promise<void>;
  setMcpExtensionPreferences?: (
    preferences: McpExtensionEnablement
  ) => Promise<McpExtensionEnablement>;
  subscribeMcpConfig: (
    listener: (config: { error?: string; exists: boolean; path: string }) => void
  ) => () => void;
  subscribeMcpExtensionPreferences?: (
    listener: (preferences: McpExtensionEnablement) => void
  ) => () => void;
  subscribeMcpServerStatus?: (listener: (event: McpHostWatchEvent) => void) => () => void;
  subscribeMcpTools: (listener: () => void) => () => void;
  writeMcpConfigText?: (
    content: string
  ) => Promise<{ error?: string; path: string; success: boolean }>;
}

let capturedOperations: CapturedToolsOperations | null = null;

const hostSnapshot = {
  revision: 7,
  servers: [
    {
      configuredProtocol: 'auto',
      configuredServerId: parseConfiguredMcpServerId('local'),
      generation: 2,
      negotiated: {
        advertisedCapabilityIds: ['tools'],
        era: 'modern',
        revision: '2026-07-28',
        serverIdentity: { name: 'linear', title: 'Linear', version: '2.0.0' },
      },
      state: 'connected',
      transport: 'streamable-http',
    },
  ],
} as const satisfies McpHostSnapshot;

const extensionPreferences = {
  apps: true,
  tasks: true,
} as const satisfies McpExtensionEnablement;

vi.mock('@brainstrike/agent/tool-metadata', () => ({
  DESKTOP_NATIVE_TOOL_IDS: ['native-read'],
  getNativeToolDescription: (toolId: string) =>
    toolId === 'native-read' ? 'Read local files' : undefined,
  isNativeTool: (toolId: string) => toolId === 'native-read',
  NATIVE_TOOL_DEFAULTS: {
    'native-read': {
      category: 'retrieval',
      estimatedTokens: 25,
      loadingTier: 'always',
      requiresApproval: false,
    },
  },
}));

vi.mock('@brainstrike/app-shell/diagnostics', () => ({
  createSystemDiagnosticsSettingsCategory: () => ({
    content: <div data-testid="diagnostics-category" />,
    id: 'diagnostics',
    title: 'Diagnostics',
  }),
}));

vi.mock('@brainstrike/app-shell', () => ({
  useAssistantAvailability: () => assistantAvailability.current,
  // The Provider Hub takes the probe as an injected plain FUNCTION — app-shell
  // depends on settings-ui, so it cannot be imported there, and a hook may not
  // be passed as a value.
  verifyProviderCredential: () => new Promise(() => undefined),
}));

vi.mock('@brainstrike/app-shell/cost-tracking-settings', () => ({
  createCostTrackingSettingsCategory: () => ({
    content: <div data-testid="cost-tracking-category" />,
    id: 'cost-tracking',
    title: 'Cost Tracking',
  }),
}));

vi.mock('@brainstrike/file-explorer-ui/indexing', () => ({
  useOptionalTokenCacheContext: () => ({
    countingMode: 'accurate',
    isOperational: true,
  }),
}));

vi.mock('@brainstrike/file-explorer-ui/shell', () => ({
  useFileExplorerStoreSelector: (selector: (state: FileExplorerMockState) => unknown) =>
    selector(fileExplorerMockState.current),
}));

vi.mock('@brainstrike/settings-ui/settings/models/model-runtime-services', () => ({
  configureModelRuntimeServices: vi.fn(),
}));

vi.mock('@brainstrike/settings-ui/settings/models/model-selection-page', () => ({
  ModelCatalogHeaderActions: vi.fn(() => null),
  ModelSelectionPage: modelSelectionPageMock,
}));

vi.mock('@brainstrike/settings-ui/settings/tools/index', () => ({
  createToolsSettingsCategory: createToolsSettingsCategoryMock.mockImplementation(
    ({ operations }: { operations: CapturedToolsOperations }) => {
      capturedOperations = operations;
      return {
        content: <div data-testid="tools-category" />,
        id: 'ai-tools',
        title: 'AI Tools',
      };
    }
  ),
}));

vi.mock('@brainstrike/settings-ui/settings/system/notification-settings-category', () => ({
  createNotificationSettingsCategory: () => ({
    content: <div data-testid="notifications-category" />,
    id: 'notifications',
    title: 'Notifications',
  }),
}));

vi.mock('@brainstrike/settings-ui/settings-page-content', () => ({
  SettingsPageContent: ({
    categories,
    defaultCategoryId,
  }: {
    categories: Array<{ content: React.ReactNode; id: string; title: string }>;
    defaultCategoryId: string;
  }) => (
    <div data-default-category-id={defaultCategoryId} data-testid="settings-layout">
      {categories.map((category) => (
        <span data-testid="settings-category-title" key={category.id}>
          {category.title}
        </span>
      ))}
      {categories.find(({ id }) => id === 'embedding-models')?.content}
    </div>
  ),
}));

vi.mock('@brainstrike/settings-ui/settings-category-factories', () => ({
  createAppearanceSettingsCategory: () => ({
    content: <div data-testid="appearance-category" />,
    id: 'appearance',
    title: 'Appearance',
  }),
  createAssistantMemorySettingsCategory:
    createAssistantMemorySettingsCategoryMock.mockImplementation(() => ({
      content: <div data-testid="assistant-memory-category" />,
      id: 'assistant-memory',
      title: 'Assistant Memory',
    })),
  createFactoryResetSettingsCategory: vi.fn((options: unknown) => ({
    content: <div data-options={JSON.stringify(options)} data-testid="factory-reset-category" />,
    id: 'factory-reset',
    title: 'Factory Reset',
  })),
  createHooksSettingsCategory: createHooksSettingsCategoryMock.mockImplementation(() => ({
    content: <div data-testid="hooks-category" />,
    id: 'hooks',
    title: 'Hooks',
  })),
  createLocalRuntimeSettingsCategory: () => ({
    content: <div data-testid="local-runtime-category" />,
    id: 'local-runtime',
    title: 'Local Runtime',
  }),
  createPermissionSettingsCategory: () => ({
    content: <div data-testid="permissions-category" />,
    id: 'permissions',
    title: 'Permissions',
  }),
  createSearchIndexingSettingsCategory: () => ({
    content: <div data-testid="search-indexing-category" />,
    id: 'search-indexing',
    title: 'Search & Indexing',
  }),
  createSubagentPersonasSettingsCategory: () => ({
    content: <div data-testid="subagents-category" />,
    id: 'subagents',
    title: 'Subagents',
  }),
  createTokenCountingSettingsCategoryWithRuntimeSupport:
    createTokenCountingSettingsCategoryMock.mockImplementation((options: unknown) => ({
      content: <div data-options={JSON.stringify(options)} data-testid="token-counting-category" />,
      id: 'token-counting',
      title: 'Token Counting',
    })),
  createWorkspaceSettingsCategory: vi.fn((options: unknown) => ({
    content: <div data-options={JSON.stringify(options)} data-testid="workspace-category" />,
    id: 'workspace',
    title: 'Workspace',
  })),
}));

vi.mock('@brainstrike/app-state/automation-overrides', () => ({
  getAccurateRuntimeAvailabilityTestOverride: () => undefined,
}));

vi.mock('@brainstrike/app-state/stores/native-tool-preferences-store', () => ({
  useNativeToolPreferencesStore: {
    getState: () => ({
      isToolEnabled: (toolId: string) => toolId === 'native-read',
      resetTools: resetToolsMock,
      setToolsEnabled: setToolsEnabledMock,
    }),
  },
}));

vi.mock('../../../../renderer/components/settings/logging-settings', () => ({
  DesktopLoggingSettings: () => <div data-testid="logging-settings" />,
}));

interface DesktopTestWindow {
  assistant?: {
    url: string;
  };
  mcp?: {
    complete?: (request: unknown) => Promise<unknown>;
    createSampleConfig?: () => Promise<{ path: string; success: boolean }>;
    disableTools?: (ids: string[]) => Promise<void>;
    getPrompt?: (request: unknown) => Promise<unknown>;
    readResource?: (request: unknown) => Promise<unknown>;
    enableTools?: (ids: string[]) => Promise<void>;
    getConfig?: () => Promise<{ error?: string; exists: boolean; path: string } | null>;
    getExtensionPreferences?: () => Promise<McpExtensionEnablement>;
    getPath?: () => Promise<string>;
    getServerStatusSnapshot?: () => Promise<McpHostSnapshot>;
    getToolStats?: () => Promise<{
      enabled: number;
      servers: number;
      total: number;
      preferencesFault?: McpToolPreferencesFault;
    }>;
    listTools?: () => Promise<
      Record<
        string,
        Array<{
          description?: string;
          enabled: boolean;
          id: string;
          inputSchema?: unknown;
          serverName?: string;
        }>
      >
    >;
    onExtensionPreferencesUpdated?: (
      listener: (preferences: McpExtensionEnablement) => void
    ) => (() => void) | undefined;
    onServerStatusUpdated?: (
      listener: (snapshot: McpHostSnapshot) => void
    ) => (() => void) | undefined;
    onConfigUpdated?: (
      listener: (config: { error?: string; exists: boolean; path: string }) => void
    ) => (() => void) | undefined;
    onToolsUpdated?: (listener: (tools: unknown) => void) => (() => void) | undefined;
    readConfigText?: () => Promise<{ content: string; path: string } | null>;
    reloadToolPreferences?: () => Promise<void>;
    resetTools?: () => Promise<void>;
    selectPath?: () => Promise<string | null>;
    setExtensionPreferences?: (
      preferences: McpExtensionEnablement
    ) => Promise<McpExtensionEnablement>;
    setPath?: (path: string | null) => Promise<{ path: string; success: boolean }>;
    writeConfigText?: (
      content: string
    ) => Promise<{ error?: string; path: string; success: boolean } | null>;
  };
}

const getDesktopWindow = (): DesktopTestWindow => window as unknown as DesktopTestWindow;

describe('desktop SettingsPageContent tool operations', () => {
  beforeEach(() => {
    capturedOperations = null;
    vi.clearAllMocks();
    fileExplorerMockState.current = {
      activeRootIds: [],
      devInlineFixtureEnabled: true,
      rootDescriptors: {},
      setDevInlineFixtureEnabled: () => {},
    };
    assistantAvailability.current = { state: 'loading' };

    const desktopWindow = getDesktopWindow();
    desktopWindow.assistant = undefined;
    desktopWindow.mcp = {
      complete: vi.fn(async () => ({
        result: { completion: { values: ['BST-1585'] } },
        type: 'completion/complete',
      })),
      createSampleConfig: vi.fn(async () => ({ path: '/tmp/sample.json', success: true })),
      disableTools: vi.fn(async () => {}),
      enableTools: vi.fn(async () => {}),
      getConfig: vi.fn(async () => ({ exists: true, path: '/tmp/mcp.json' })),
      getExtensionPreferences: vi.fn(async () => extensionPreferences),
      getPath: vi.fn(async () => '/tmp/mcp.json'),
      getPrompt: vi.fn(async () => ({
        result: { messages: [{ content: { text: 'Summarize', type: 'text' }, role: 'user' }] },
        type: 'prompts/get',
      })),
      getServerStatusSnapshot: vi.fn(async () => hostSnapshot),
      getToolStats: vi.fn(async () => ({ enabled: 1, servers: 1, total: 2 })),
      listTools: vi.fn(async () => ({
        local: [
          {
            description: 'Search files',
            enabled: false,
            id: 'mcp-search',
            inputSchema: { type: 'object' },
            serverName: 'local',
          },
        ],
      })),
      onConfigUpdated: vi.fn(() => vi.fn()),
      onExtensionPreferencesUpdated: vi.fn(() => vi.fn()),
      onServerStatusUpdated: vi.fn(() => vi.fn()),
      onToolsUpdated: vi.fn(() => vi.fn()),
      readConfigText: vi.fn(async () => ({
        content: '{}',
        error: 'invalid_mcp_config: servers: required',
        path: '/tmp/mcp.json',
      })),
      readResource: vi.fn(async () => ({
        result: { contents: [{ text: '# BST-1585', uri: 'linear://issue/BST-1585' }] },
        type: 'resources/read',
      })),
      resetTools: vi.fn(async () => {}),
      selectPath: vi.fn(async () => '/tmp/selected.json'),
      setExtensionPreferences: vi.fn(async (preferences: McpExtensionEnablement) => preferences),
      setPath: vi.fn(async (path) => ({ path: path ?? '/tmp/default.json', success: true })),
      writeConfigText: vi.fn(async () => ({ path: '/tmp/mcp.json', success: true })),
    };
  });

  it('forwards tool preference reload through the desktop capability', async () => {
    const desktopWindow = getDesktopWindow();
    if (!desktopWindow.mcp) {
      throw new Error('Expected MCP test bridge');
    }
    const reload = vi.fn(async (): Promise<void> => {});
    desktopWindow.mcp.reloadToolPreferences = reload;
    const { default: SettingsPageContent } = await import(
      '../../../../renderer/components/settings/page-content'
    );
    render(<SettingsPageContent />);
    if (!capturedOperations?.reloadToolPreferences) {
      throw new Error('Expected reload operation');
    }
    await capturedOperations.reloadToolPreferences();
    expect(reload).toHaveBeenCalledOnce();
    expect(resetToolsMock).not.toHaveBeenCalled();
    expect(desktopWindow.mcp.resetTools).not.toHaveBeenCalled();
  });

  it('omits tool preference reload when its bridge capability is unavailable', async () => {
    const { default: SettingsPageContent } = await import(
      '../../../../renderer/components/settings/page-content'
    );
    render(<SettingsPageContent />);
    if (!capturedOperations) {
      throw new Error('Expected tools operations');
    }
    expect(capturedOperations.reloadToolPreferences).toBeUndefined();
  });

  it.each(['enableTools', 'disableTools'] as const)(
    'normalizes the exact Electron transport wrapper for %s rejection',
    async (operation) => {
      const mcp = getDesktopWindow().mcp;
      if (!mcp) {
        throw new Error('Expected MCP bridge');
      }
      const faultMessage = 'Preferences could not be loaded. Repair and Reload tool preferences.';
      const channel = operation === 'enableTools' ? 'mcp:tools:enable' : 'mcp:tools:disable';
      mcp.getToolStats = vi.fn().mockResolvedValue({
        enabled: 0,
        preferencesFault: {
          kind: 'invalid',
          message: faultMessage,
          path: '/profile/mcp/tool-preferences.json',
        },
        servers: 1,
        total: 2,
      });
      mcp[operation] = vi
        .fn()
        .mockRejectedValue(
          new Error(`Error invoking remote method '${channel}': Error: ${faultMessage}`)
        );
      const { default: SettingsPageContent } = await import(
        '../../../../renderer/components/settings/page-content'
      );
      render(<SettingsPageContent />);
      if (!capturedOperations) {
        throw new Error('Expected tools operations');
      }
      await expect(capturedOperations[operation](['mcp-search'])).rejects.toMatchObject({
        message: faultMessage,
      });
    }
  );

  it('preserves distinct failure content while normalizing its Electron transport wrapper', async () => {
    const mcp = getDesktopWindow().mcp;
    if (!mcp) {
      throw new Error('Expected MCP bridge');
    }
    const faultMessage = 'Preferences could not be loaded. Repair and Reload tool preferences.';
    const error = new Error(
      `Error invoking remote method 'mcp:tools:enable': Error: Another failure; ${faultMessage}`
    );
    mcp.getToolStats = vi.fn().mockResolvedValue({
      enabled: 0,
      preferencesFault: {
        kind: 'invalid',
        message: faultMessage,
        path: '/profile/mcp/tool-preferences.json',
      },
      servers: 1,
      total: 2,
    });
    mcp.enableTools = vi.fn().mockRejectedValue(error);
    const { default: SettingsPageContent } = await import(
      '../../../../renderer/components/settings/page-content'
    );
    render(<SettingsPageContent />);
    if (!capturedOperations) {
      throw new Error('Expected tools operations');
    }
    await expect(capturedOperations.enableTools(['mcp-search'])).rejects.toMatchObject({
      cause: error,
      message: `Another failure; ${faultMessage}`,
    });
  });

  it('normalizes an in-flight refusal after reload has cleared main fault stats', async () => {
    const mcp = getDesktopWindow().mcp;
    if (!mcp) {
      throw new Error('Expected MCP bridge');
    }
    const faultMessage = 'Preferences could not be loaded. Repair and Reload tool preferences.';
    const refused = Promise.withResolvers<void>();
    mcp.enableTools = vi.fn(() => refused.promise);
    mcp.getToolStats = vi.fn().mockResolvedValue({
      enabled: 0,
      preferencesFault: {
        kind: 'invalid',
        message: faultMessage,
        path: '/profile/mcp/tool-preferences.json',
      },
      servers: 1,
      total: 2,
    });
    mcp.reloadToolPreferences = vi.fn(async (): Promise<void> => {
      mcp.getToolStats = vi.fn().mockResolvedValue({ enabled: 2, servers: 1, total: 2 });
    });
    const { default: SettingsPageContent } = await import(
      '../../../../renderer/components/settings/page-content'
    );
    render(<SettingsPageContent />);
    if (!capturedOperations?.reloadToolPreferences) {
      throw new Error('Expected tools operations');
    }
    await capturedOperations.getStats();
    const attempt = capturedOperations.enableTools(['mcp-search']);
    const rejected = expect(attempt).rejects.toMatchObject({ message: faultMessage });
    await capturedOperations.reloadToolPreferences();
    await capturedOperations.getStats();
    refused.reject(
      new Error(`Error invoking remote method 'mcp:tools:enable': Error: ${faultMessage}`)
    );
    await rejected;
  });

  it('wires desktop MCP and native tool operations through the settings category', async () => {
    const { default: SettingsPageContent } = await import(
      '../../../../renderer/components/settings/page-content'
    );

    render(<SettingsPageContent />);

    expect(createToolsSettingsCategoryMock).toHaveBeenCalledWith(
      expect.objectContaining({ mcpAvailable: true })
    );
    expect(createTokenCountingSettingsCategoryMock).toHaveBeenCalledWith({
      accurateRuntimeAvailable: true,
    });
    if (!capturedOperations) {
      throw new Error('Expected tools operations to be captured');
    }

    await expect(capturedOperations.getTools()).resolves.toEqual([
      expect.objectContaining({
        enabled: true,
        id: 'native-read',
        source: 'native',
      }),
      expect.objectContaining({
        enabled: false,
        id: 'mcp-search',
        serverName: 'local',
        source: 'mcp',
      }),
    ]);
    await expect(capturedOperations.getStats()).resolves.toMatchObject({
      byCategory: expect.objectContaining({ action: 2, retrieval: 1 }),
      bySource: { mcp: 2, native: 1 },
      enabled: 2,
      total: 3,
    });

    await capturedOperations.enableTools(['native-read', 'mcp-search']);
    expect(setToolsEnabledMock).toHaveBeenCalledWith(['native-read'], true);
    expect(getDesktopWindow().mcp?.enableTools).toHaveBeenCalledWith(['mcp-search']);

    await capturedOperations.disableTools(['native-read', 'mcp-search']);
    expect(setToolsEnabledMock).toHaveBeenCalledWith(['native-read'], false);
    expect(getDesktopWindow().mcp?.disableTools).toHaveBeenCalledWith(['mcp-search']);

    await capturedOperations.resetTools();
    expect(resetToolsMock).toHaveBeenCalled();
    expect(getDesktopWindow().mcp?.resetTools).toHaveBeenCalled();

    await capturedOperations.refreshMcpServers();
    await capturedOperations.openMcpConfig();
    expect(getDesktopWindow().mcp?.setPath).toHaveBeenCalledWith('/tmp/selected.json');
    await capturedOperations.resetMcpConfig();
    expect(getDesktopWindow().mcp?.setPath).toHaveBeenCalledWith(null);

    await expect(capturedOperations.getMcpConfigPath?.()).resolves.toBe('/tmp/mcp.json');
    await expect(capturedOperations.readMcpConfigText?.()).resolves.toEqual({
      content: '{}',
      error: 'invalid_mcp_config: servers: required',
      path: '/tmp/mcp.json',
    });
    await expect(capturedOperations.writeMcpConfigText?.('{"servers":{}}')).resolves.toEqual({
      path: '/tmp/mcp.json',
      success: true,
    });
    await expect(capturedOperations.getMcpConfigInfo()).resolves.toEqual({
      exists: true,
      path: '/tmp/mcp.json',
    });
    await expect(capturedOperations.createSampleConfig()).resolves.toEqual({
      path: '/tmp/sample.json',
      success: true,
    });

    expect(capturedOperations).not.toHaveProperty('executeToolTest');

    const setPath = getDesktopWindow().mcp?.setPath;
    if (!setPath) {
      throw new Error('Expected MCP setPath bridge to be available.');
    }
    vi.mocked(setPath).mockResolvedValueOnce({
      path: '/tmp/mcp.json',
      success: false,
    });
    await expect(capturedOperations.setMcpConfigPath?.('/tmp/bad.json')).rejects.toThrow(
      'Failed to set MCP config path'
    );
  });

  it('forwards user-initiated MCP content browsing to the bridge verbs (BST-1585)', async () => {
    const { default: SettingsPageContent } = await import(
      '../../../../renderer/components/settings/page-content'
    );
    render(<SettingsPageContent />);
    if (!capturedOperations) {
      throw new Error('Expected tools operations to be captured');
    }
    const mcp = getDesktopWindow().mcp;
    const authority = { configuredServerId: parseConfiguredMcpServerId('local'), generation: 1 };
    const readRequest = { authority, uri: 'linear://issue/BST-1585' };
    await expect(capturedOperations.readMcpResource?.(readRequest)).resolves.toMatchObject({
      type: 'resources/read',
    });
    expect(mcp?.readResource).toHaveBeenCalledWith(readRequest);
    const promptRequest = { arguments: { identifier: 'BST-1585' }, authority, name: 'summary' };
    await expect(capturedOperations.getMcpPrompt?.(promptRequest)).resolves.toMatchObject({
      type: 'prompts/get',
    });
    expect(mcp?.getPrompt).toHaveBeenCalledWith(promptRequest);
    const completeRequest = {
      argument: { name: 'identifier', value: 'BST' },
      authority,
      ref: { name: 'summary', type: 'ref/prompt' },
    };
    await expect(capturedOperations.completeMcpContent?.(completeRequest)).resolves.toMatchObject({
      type: 'completion/complete',
    });
    expect(mcp?.complete).toHaveBeenCalledWith(completeRequest);
  });

  it('omits MCP content browsing operations when the bridge lacks the verbs', async () => {
    const desktopWindow = getDesktopWindow();
    const {
      complete: _complete,
      getPrompt: _getPrompt,
      readResource: _readResource,
      ...rest
    } = desktopWindow.mcp ?? {};
    desktopWindow.mcp = rest;
    const { default: SettingsPageContent } = await import(
      '../../../../renderer/components/settings/page-content'
    );
    render(<SettingsPageContent />);
    if (!capturedOperations) {
      throw new Error('Expected tools operations to be captured');
    }
    expect(capturedOperations).not.toHaveProperty('readMcpResource');
    expect(capturedOperations).not.toHaveProperty('getMcpPrompt');
    expect(capturedOperations).not.toHaveProperty('completeMcpContent');
    expect(capturedOperations).toHaveProperty('getMcpServerStatus');
  });

  it('returns main-process status snapshots without inferring from tools', async () => {
    const { default: SettingsPageContent } = await import(
      '../../../../renderer/components/settings/page-content'
    );
    render(<SettingsPageContent />);
    if (!capturedOperations) {
      throw new Error('Expected tools operations to be captured');
    }
    const mcp = getDesktopWindow().mcp;
    if (!mcp?.listTools) {
      throw new Error('Expected MCP tool bridge to be available');
    }
    const callsBeforeStatus = vi.mocked(mcp.listTools).mock.calls.length;
    await expect(capturedOperations.getMcpServerStatus()).resolves.toEqual(hostSnapshot);
    expect(mcp.listTools).toHaveBeenCalledTimes(callsBeforeStatus);

    const listener = vi.fn();
    const subscribeMcpServerStatus = capturedOperations.subscribeMcpServerStatus;
    if (!subscribeMcpServerStatus) {
      throw new Error('Expected MCP status subscription to be available');
    }
    const onServerStatusUpdated = mcp.onServerStatusUpdated;
    if (!onServerStatusUpdated) {
      throw new Error('Expected MCP status bridge subscription to be available');
    }
    const statusDisposer = vi.fn();
    vi.mocked(onServerStatusUpdated).mockReturnValueOnce(statusDisposer);
    const unsubscribe = subscribeMcpServerStatus(listener);
    expect(onServerStatusUpdated).toHaveBeenCalledWith(listener);
    const forwardedStatusListener = vi.mocked(onServerStatusUpdated).mock.calls[0]?.[0];
    forwardedStatusListener?.(hostSnapshot);
    expect(listener).toHaveBeenCalledWith(hostSnapshot);
    unsubscribe();
    expect(statusDisposer).toHaveBeenCalledOnce();

    const configListener = vi.fn();
    const onConfigUpdated = mcp.onConfigUpdated;
    if (!onConfigUpdated) {
      throw new Error('Expected MCP config bridge subscription to be available');
    }
    const configDisposer = vi.fn();
    vi.mocked(onConfigUpdated).mockReturnValueOnce(configDisposer);
    const unsubscribeConfig = capturedOperations.subscribeMcpConfig(configListener);
    expect(onConfigUpdated).toHaveBeenCalledWith(configListener);
    const forwardedConfigListener = vi.mocked(onConfigUpdated).mock.calls[0]?.[0];
    const configUpdate = { exists: false, path: '/tmp/new-mcp.json' };
    forwardedConfigListener?.(configUpdate);
    expect(configListener).toHaveBeenCalledWith(configUpdate);
    unsubscribeConfig();
    expect(configDisposer).toHaveBeenCalledOnce();

    const toolsListener = vi.fn();
    const onToolsUpdated = mcp.onToolsUpdated;
    if (!onToolsUpdated) {
      throw new Error('Expected MCP tools bridge subscription to be available');
    }
    const toolsDisposer = vi.fn();
    vi.mocked(onToolsUpdated).mockReturnValueOnce(toolsDisposer);
    const unsubscribeTools = capturedOperations.subscribeMcpTools(toolsListener);
    expect(onToolsUpdated).toHaveBeenCalledWith(expect.any(Function));
    const forwardedToolsListener = vi.mocked(onToolsUpdated).mock.calls[0]?.[0];
    forwardedToolsListener?.(undefined);
    expect(toolsListener).toHaveBeenCalledOnce();
    unsubscribeTools();
    expect(toolsDisposer).toHaveBeenCalledOnce();

    Reflect.deleteProperty(mcp, 'getServerStatusSnapshot');
    await expect(capturedOperations.getMcpServerStatus()).rejects.toThrow(
      'MCP bridge is missing getServerStatusSnapshot'
    );
  });

  it('exposes the global MCP extension dials backed by the preload bridge', async () => {
    const { default: SettingsPageContent } = await import(
      '../../../../renderer/components/settings/page-content'
    );
    render(<SettingsPageContent />);
    if (!capturedOperations) {
      throw new Error('Expected tools operations to be captured');
    }
    const mcp = getDesktopWindow().mcp;
    const getExtensionPreferences = mcp?.getExtensionPreferences;
    const setExtensionPreferences = mcp?.setExtensionPreferences;
    const onExtensionPreferencesUpdated = mcp?.onExtensionPreferencesUpdated;
    if (!(getExtensionPreferences && setExtensionPreferences && onExtensionPreferencesUpdated)) {
      throw new Error('Expected MCP extension preference bridge to be available');
    }

    const getMcpExtensionPreferences = capturedOperations.getMcpExtensionPreferences;
    if (!getMcpExtensionPreferences) {
      throw new Error('Expected getMcpExtensionPreferences to be exposed');
    }
    await expect(getMcpExtensionPreferences()).resolves.toEqual(extensionPreferences);
    expect(getExtensionPreferences).toHaveBeenCalledOnce();

    const setMcpExtensionPreferences = capturedOperations.setMcpExtensionPreferences;
    if (!setMcpExtensionPreferences) {
      throw new Error('Expected setMcpExtensionPreferences to be exposed');
    }
    await expect(setMcpExtensionPreferences({ apps: false, tasks: true })).resolves.toEqual({
      apps: false,
      tasks: true,
    });
    expect(setExtensionPreferences).toHaveBeenCalledWith({ apps: false, tasks: true });

    const subscribeMcpExtensionPreferences = capturedOperations.subscribeMcpExtensionPreferences;
    if (!subscribeMcpExtensionPreferences) {
      throw new Error('Expected subscribeMcpExtensionPreferences to be exposed');
    }
    const disposer = vi.fn();
    vi.mocked(onExtensionPreferencesUpdated).mockReturnValueOnce(disposer);
    const listener = vi.fn();
    const unsubscribe = subscribeMcpExtensionPreferences(listener);
    expect(onExtensionPreferencesUpdated).toHaveBeenCalledWith(listener);
    const forwarded = vi.mocked(onExtensionPreferencesUpdated).mock.calls[0]?.[0];
    forwarded?.({ apps: false, tasks: false });
    expect(listener).toHaveBeenCalledWith({ apps: false, tasks: false });
    unsubscribe();
    expect(disposer).toHaveBeenCalledOnce();
  });

  it('omits the MCP extension dial operations when the bridge lacks the verbs', async () => {
    const desktopWindow = getDesktopWindow();
    const {
      getExtensionPreferences: _get,
      onExtensionPreferencesUpdated: _subscribe,
      setExtensionPreferences: _set,
      ...rest
    } = desktopWindow.mcp ?? {};
    desktopWindow.mcp = rest;
    const { default: SettingsPageContent } = await import(
      '../../../../renderer/components/settings/page-content'
    );
    render(<SettingsPageContent />);

    expect(capturedOperations).not.toHaveProperty('getMcpExtensionPreferences');
    expect(capturedOperations).not.toHaveProperty('setMcpExtensionPreferences');
    expect(capturedOperations).not.toHaveProperty('subscribeMcpExtensionPreferences');
  });

  it('omits the live status operation when the preload subscription is unavailable', async () => {
    const mcp = getDesktopWindow().mcp;
    if (!mcp) {
      throw new Error('Expected MCP bridge to be available');
    }
    Reflect.deleteProperty(mcp, 'onServerStatusUpdated');
    const { default: SettingsPageContent } = await import(
      '../../../../renderer/components/settings/page-content'
    );

    render(<SettingsPageContent />);

    expect(capturedOperations).not.toHaveProperty('subscribeMcpServerStatus');
  });

  it('rejects MCP tool projection identities that disagree with their group key', async () => {
    const mcp = getDesktopWindow().mcp;
    if (!mcp?.listTools) {
      throw new Error('Expected MCP tools bridge to be available');
    }
    vi.mocked(mcp.listTools).mockResolvedValueOnce({
      local: [
        {
          enabled: true,
          id: 'local.search',
          serverName: 'different-server',
        },
      ],
    });
    const { default: SettingsPageContent } = await import(
      '../../../../renderer/components/settings/page-content'
    );
    render(<SettingsPageContent />);
    if (!capturedOperations) {
      throw new Error('Expected tools operations to be captured');
    }

    await expect(capturedOperations.getTools()).rejects.toThrow(
      'MCP tool projection identity mismatch: group "local" contains server "different-server"'
    );
  });

  it('passes status provider key sources into the Assistant Memory category', async () => {
    getDesktopWindow().assistant = { url: 'http://127.0.0.1:4111' };
    assistantAvailability.current = {
      providerKeySources: [{ envVar: 'OPENAI_API_KEY', provider: 'openai', source: 'env' }],
      providers: ['openai', 'local'],
      state: 'enabled',
    };
    const { default: SettingsPageContent } = await import(
      '../../../../renderer/components/settings/page-content'
    );

    render(<SettingsPageContent />);

    expect(createAssistantMemorySettingsCategoryMock).toHaveBeenCalledWith({
      assistantMemoryBackendAvailable: true,
      providerKeySources: [{ envVar: 'OPENAI_API_KEY', provider: 'openai', source: 'env' }],
    });
    // The Model Catalog page no longer carries the memory settings.
    expect(modelSelectionPageMock).toHaveBeenCalledWith({}, undefined);
  });

  it('omits provider key sources from Assistant Memory while availability is loading', async () => {
    const { default: SettingsPageContent } = await import(
      '../../../../renderer/components/settings/page-content'
    );

    render(<SettingsPageContent />);

    expect(createAssistantMemorySettingsCategoryMock).toHaveBeenLastCalledWith({
      assistantMemoryBackendAvailable: expect.any(Boolean),
    });
  });

  it('lists Assistant Memory right after Model Catalog', async () => {
    const { default: SettingsPageContent } = await import(
      '../../../../renderer/components/settings/page-content'
    );

    const { getAllByTestId } = render(<SettingsPageContent />);

    const titles = getAllByTestId('settings-category-title').map((node) => node.textContent);
    expect(titles.indexOf('Assistant Memory')).toBe(titles.indexOf('Model Catalog') + 1);
  });

  it('threads the live mounted workspace roots into the Hooks settings category', async () => {
    fileExplorerMockState.current = {
      activeRootIds: ['root-b', 'root-a'],
      devInlineFixtureEnabled: true,
      rootDescriptors: {
        'root-a': { displayName: 'Workspace A', path: '/ws/a', rootId: 'root-a' },
        'root-b': { displayName: 'Workspace B', path: '/ws/b', rootId: 'root-b' },
      },
      setDevInlineFixtureEnabled: () => {},
    };

    const { default: SettingsPageContent } = await import(
      '../../../../renderer/components/settings/page-content'
    );

    render(<SettingsPageContent />);

    // Roots follow activeRootIds order (sidebar order), keyed by durable rootId.
    expect(createHooksSettingsCategoryMock).toHaveBeenCalledWith({
      roots: [
        { absPath: '/ws/b', displayName: 'Workspace B', rootId: 'root-b' },
        { absPath: '/ws/a', displayName: 'Workspace A', rootId: 'root-a' },
      ],
    });
  });

  it('passes an empty roots list to the Hooks category when nothing is mounted', async () => {
    const { default: SettingsPageContent } = await import(
      '../../../../renderer/components/settings/page-content'
    );

    render(<SettingsPageContent />);

    expect(createHooksSettingsCategoryMock).toHaveBeenCalledWith({ roots: [] });
  });
});
