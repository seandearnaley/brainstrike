import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const setToolsEnabledMock = vi.hoisted(() => vi.fn());
const resetToolsMock = vi.hoisted(() => vi.fn());
const createToolsSettingsCategoryMock = vi.hoisted(() => vi.fn());
const createTokenCountingSettingsCategoryMock = vi.hoisted(() => vi.fn());
const createHooksSettingsCategoryMock = vi.hoisted(() => vi.fn());

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
  createSampleConfig: () => Promise<{ error?: string; path: string; success: boolean }>;
  disableTools: (ids: string[]) => Promise<void>;
  enableTools: (ids: string[]) => Promise<void>;
  executeToolTest: (
    toolId: string,
    input: unknown
  ) => Promise<{ durationMs: number; error?: string; result?: unknown; success: boolean }>;
  getMcpConfigInfo: () => Promise<{ error?: string; exists: boolean; path: string } | null>;
  getMcpConfigPath?: () => Promise<string>;
  getMcpServerStatus: () => Promise<Array<{ name: string; status: string; toolCount: number }>>;
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
  refreshMcpServers: () => Promise<void>;
  resetMcpConfig: () => Promise<void>;
  resetTools: () => Promise<void>;
  setMcpConfigPath?: (configPath: string | null) => Promise<void>;
  writeMcpConfigText?: (
    content: string
  ) => Promise<{ error?: string; path: string; success: boolean }>;
}

let capturedOperations: CapturedToolsOperations | null = null;

vi.mock('@brainstrike/agent/tool-metadata', () => ({
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

vi.mock('@brainstrike/app-shell/cost-tracking', () => ({
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

vi.mock('@brainstrike/preferences/settings/models/model-runtime-services', () => ({
  configureModelRuntimeServices: vi.fn(),
}));

vi.mock('@brainstrike/preferences/settings/models/model-selection-page', () => ({
  ModelSelectionPage: () => <div data-testid="model-selection-page" />,
}));

vi.mock('@brainstrike/preferences/settings/tools/index', () => ({
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

vi.mock('@brainstrike/preferences/settings/system/notification-settings-category', () => ({
  createNotificationSettingsCategory: () => ({
    content: <div data-testid="notifications-category" />,
    id: 'notifications',
    title: 'Notifications',
  }),
}));

vi.mock('@brainstrike/preferences/settings-page-content', () => ({
  createApiKeysSettingsCategory: () => ({
    content: <div data-testid="api-keys-category" />,
    id: 'api-keys',
    title: 'API Keys',
  }),
  createAppearanceSettingsCategory: () => ({
    content: <div data-testid="appearance-category" />,
    id: 'appearance',
    title: 'Appearance',
  }),
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
  SettingsPageContent: ({
    categories,
    defaultCategoryId,
  }: {
    categories: Array<{ id: string; title: string }>;
    defaultCategoryId: string;
  }) => (
    <div data-default-category-id={defaultCategoryId} data-testid="settings-layout">
      {categories.map((category) => (
        <span data-testid="settings-category-title" key={category.id}>
          {category.title}
        </span>
      ))}
    </div>
  ),
}));

vi.mock('@brainstrike/preferences/settings-test-runtime-access', () => ({
  getAccurateRuntimeAvailabilityTestOverride: () => undefined,
}));

vi.mock('@brainstrike/preferences/stores/native-tool-preferences-store', () => ({
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

interface DesktopTestWindow extends Window {
  mcp?: {
    createSampleConfig?: () => Promise<{ path: string; success: boolean }>;
    disableTools?: (ids: string[]) => Promise<void>;
    enableTools?: (ids: string[]) => Promise<void>;
    getConfig?: () => Promise<{ error?: string; exists: boolean; path: string } | null>;
    getPath?: () => Promise<string>;
    getToolStats?: () => Promise<{ enabled: number; servers: number; total: number }>;
    listTools?: () => Promise<
      Record<
        string,
        Array<{ description?: string; enabled: boolean; id: string; inputSchema?: unknown }>
      >
    >;
    readConfigText?: () => Promise<{ content: string; path: string } | null>;
    resetTools?: () => Promise<void>;
    selectPath?: () => Promise<string | null>;
    setPath?: (path: string | null) => Promise<{ path: string; success: boolean }>;
    writeConfigText?: (
      content: string
    ) => Promise<{ error?: string; path: string; success: boolean } | null>;
  };
  tools?: {
    execute?: (
      toolId: string,
      input: unknown
    ) => Promise<{ durationMs: number; error?: string; result?: unknown; success: boolean }>;
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

    const desktopWindow = getDesktopWindow();
    desktopWindow.mcp = {
      createSampleConfig: vi.fn(async () => ({ path: '/tmp/sample.json', success: true })),
      disableTools: vi.fn(async () => {}),
      enableTools: vi.fn(async () => {}),
      getConfig: vi.fn(async () => ({ exists: true, path: '/tmp/mcp.json' })),
      getPath: vi.fn(async () => '/tmp/mcp.json'),
      getToolStats: vi.fn(async () => ({ enabled: 1, servers: 1, total: 2 })),
      listTools: vi.fn(async () => ({
        local: [
          {
            description: 'Search files',
            enabled: false,
            id: 'mcp-search',
            inputSchema: { type: 'object' },
          },
        ],
      })),
      readConfigText: vi.fn(async () => ({ content: '{}', path: '/tmp/mcp.json' })),
      resetTools: vi.fn(async () => {}),
      selectPath: vi.fn(async () => '/tmp/selected.json'),
      setPath: vi.fn(async (path) => ({ path: path ?? '/tmp/default.json', success: true })),
      writeConfigText: vi.fn(async () => ({ path: '/tmp/mcp.json', success: true })),
    };
    desktopWindow.tools = {
      execute: vi.fn(async (toolId) =>
        toolId === 'ok-tool'
          ? { durationMs: 7, result: { ok: true }, success: true }
          : { durationMs: 3, error: 'failed', success: false }
      ),
    };
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

    await expect(capturedOperations.getMcpServerStatus()).resolves.toEqual([
      { name: 'local', status: 'connected', toolCount: 1 },
    ]);
    await capturedOperations.refreshMcpServers();
    await capturedOperations.openMcpConfig();
    expect(getDesktopWindow().mcp?.setPath).toHaveBeenCalledWith('/tmp/selected.json');
    await capturedOperations.resetMcpConfig();
    expect(getDesktopWindow().mcp?.setPath).toHaveBeenCalledWith(null);

    await expect(capturedOperations.getMcpConfigPath?.()).resolves.toBe('/tmp/mcp.json');
    await expect(capturedOperations.readMcpConfigText?.()).resolves.toEqual({
      content: '{}',
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

    await expect(capturedOperations.executeToolTest('ok-tool', { input: true })).resolves.toEqual({
      durationMs: 7,
      result: { ok: true },
      success: true,
    });
    await expect(capturedOperations.executeToolTest('bad-tool', {})).resolves.toEqual({
      durationMs: 3,
      error: 'failed',
      success: false,
    });

    vi.mocked(getDesktopWindow().mcp?.setPath).mockResolvedValueOnce({
      path: '/tmp/mcp.json',
      success: false,
    });
    await expect(capturedOperations.setMcpConfigPath?.('/tmp/bad.json')).rejects.toThrow(
      'Failed to set MCP config path'
    );
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
