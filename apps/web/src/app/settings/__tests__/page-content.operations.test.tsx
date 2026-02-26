import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { HelmetProvider } from 'react-helmet-async';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import SettingsPageContent from '../page-content';

type MockToolCategory = 'retrieval' | 'action' | 'analysis' | 'configuration' | 'validation';
type MockToolLoadingTier = 'critical' | 'conditional' | 'deferred';

interface MockNativeToolDefaultMetadata {
  category: MockToolCategory;
  estimatedTokens: number;
  loadingTier: MockToolLoadingTier;
  requiresApproval: boolean;
}

interface MockToolDisplayMetadata {
  category: MockToolCategory;
  description: string;
  enabled: boolean;
  estimatedTokens: number;
  id: string;
  loadingTier: MockToolLoadingTier;
  requiresApproval: boolean;
  source: 'native' | 'mcp';
}

interface MockToolsOperations {
  disableTools: (ids: string[]) => Promise<void>;
  enableTools: (ids: string[]) => Promise<void>;
  executeToolTest: (
    toolId: string,
    input: unknown
  ) => Promise<{ success: false; error: string; durationMs: number }>;
  getStats: () => Promise<{
    total: number;
    enabled: number;
    disabled: number;
    bySource: { native: number; mcp: number };
    byCategory: Record<MockToolCategory, number>;
    mcpServers: number;
  }>;
  getTools: () => Promise<MockToolDisplayMetadata[]>;
  resetTools: () => Promise<void>;
}

interface CapturedToolsOptions {
  mcpAvailable: boolean;
  operations: MockToolsOperations;
}

interface FactoryResetInlineFixtureSetting {
  available: boolean;
  checked: boolean;
  loading: boolean;
  onChange: (checked: boolean) => void;
}

interface CapturedFactoryResetOptions {
  hasStoredFolders?: boolean;
  inlineFixtureSetting?: FactoryResetInlineFixtureSetting;
  isWebPlatform?: boolean;
  onClearStoredFolders?: () => void;
}

interface CapturedLogSource {
  getInitialRecords: () => Promise<unknown[]>;
  subscribe: (handler: (record: unknown) => void) => () => void;
}

interface CapturedLoggingProps {
  logSource: CapturedLogSource;
  runtime: 'browser' | 'electron-main' | 'electron-renderer';
}

interface MockSettingsCategory {
  id: string;
  render: () => ReactNode;
  title: string;
}

const mockState = vi.hoisted(() => ({
  nativeToolDefaults: {
    'native.search': {
      category: 'retrieval',
      loadingTier: 'critical',
      estimatedTokens: 1200,
      requiresApproval: false,
    },
    'native.write': {
      category: 'action',
      loadingTier: 'conditional',
      estimatedTokens: 400,
      requiresApproval: true,
    },
  } as Record<string, MockNativeToolDefaultMetadata>,
  toolDescriptions: {
    'native.search': 'Search local files and embeddings.',
  } as Record<string, string>,
  nativeEnabledToolIds: new Set<string>(),
  setToolsEnabledMock: vi.fn<(toolIds: string[], enabled: boolean) => void>(),
  resetToolsMock: vi.fn<() => void>(),
  storedFolders: [] as string[],
  clearStoredHandlesMock: vi.fn<() => void>(),
  devInlineFixtureEnabled: false,
  setDevInlineFixtureEnabledMock: vi.fn<(checked: boolean) => void>(),
  capturedToolsOptions: null as CapturedToolsOptions | null,
  capturedFactoryResetOptions: null as CapturedFactoryResetOptions | null,
  capturedLoggingProps: null as CapturedLoggingProps | null,
  renderedCategoryIds: [] as string[],
}));

vi.mock('@brainstrike/agent/client', () => ({
  NATIVE_TOOL_DEFAULTS: mockState.nativeToolDefaults,
  TOOL_DESCRIPTIONS: mockState.toolDescriptions,
  isNativeTool: (toolId: string) => toolId in mockState.nativeToolDefaults,
}));

vi.mock('@brainstrike/app-shell', () => ({
  createSystemDiagnosticsSettingsCategory: (): MockSettingsCategory => ({
    id: 'diagnostics',
    title: 'Diagnostics',
    render: () => <div data-testid="diagnostics-category" />,
  }),
}));

vi.mock('@brainstrike/file-explorer-hooks', () => ({
  useRestoreAccess: () => ({
    storedFolders: mockState.storedFolders,
    clearStoredHandles: mockState.clearStoredHandlesMock,
    isCheckingStoredHandles: false,
    pendingRestore: null,
    showDeniedBanner: false,
    showStaleBanner: false,
    beginRestore: vi.fn(),
    dismissRestore: vi.fn(),
    chooseDifferentFolder: vi.fn(),
  }),
}));

vi.mock('@brainstrike/file-explorer-ui', () => ({
  useFileExplorerStoreContext: () => {
    return (selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        devInlineFixtureEnabled: mockState.devInlineFixtureEnabled,
        setDevInlineFixtureEnabled: mockState.setDevInlineFixtureEnabledMock,
      });
  },
}));

vi.mock('@brainstrike/preferences', () => ({
  createAppearanceSettingsCategory: (): MockSettingsCategory => ({
    id: 'appearance',
    title: 'Appearance',
    render: () => <div data-testid="appearance-category" />,
  }),
  createTokenCountingSettingsCategory: (): MockSettingsCategory => ({
    id: 'token-counting',
    title: 'Token Counting',
    render: () => <div data-testid="token-counting-category" />,
  }),
  createToolsSettingsCategory: (options: CapturedToolsOptions): MockSettingsCategory => {
    mockState.capturedToolsOptions = options;
    return {
      id: 'tools',
      title: 'Tools',
      render: () => <div data-testid="tools-category" />,
    };
  },
  createFactoryResetSettingsCategory: (
    options?: CapturedFactoryResetOptions
  ): MockSettingsCategory => {
    mockState.capturedFactoryResetOptions = options ?? null;
    return {
      id: 'factory-reset',
      title: 'Factory Reset',
      render: () => <div data-testid="factory-reset-category" />,
    };
  },
  LoggingSettingsSection: (props: CapturedLoggingProps) => {
    mockState.capturedLoggingProps = props;
    return <div data-testid="logging-settings-section" />;
  },
  ModelSelectionPage: () => <div data-testid="model-selection-page" />,
  SettingsPageContent: ({
    categories,
  }: {
    categories: MockSettingsCategory[];
    defaultCategoryId?: string;
  }) => {
    mockState.renderedCategoryIds = categories.map((category) => category.id);
    return (
      <div data-testid="settings-layout">
        {categories.map((category) => (
          <section data-testid={`category-${category.id}`} key={category.id}>
            {category.render()}
          </section>
        ))}
      </div>
    );
  },
  useNativeToolPreferencesStore: {
    getState: () => ({
      isToolEnabled: (toolId: string) => mockState.nativeEnabledToolIds.has(toolId),
      setToolsEnabled: mockState.setToolsEnabledMock,
      resetTools: mockState.resetToolsMock,
    }),
  },
}));

const renderPage = () =>
  render(
    <HelmetProvider>
      <SettingsPageContent />
    </HelmetProvider>
  );

describe('SettingsPageContent tool operations', () => {
  beforeEach(() => {
    mockState.nativeEnabledToolIds.clear();
    mockState.setToolsEnabledMock.mockClear();
    mockState.resetToolsMock.mockClear();
    mockState.clearStoredHandlesMock.mockClear();
    mockState.setDevInlineFixtureEnabledMock.mockClear();
    mockState.storedFolders = [];
    mockState.devInlineFixtureEnabled = false;
    mockState.capturedToolsOptions = null;
    mockState.capturedFactoryResetOptions = null;
    mockState.capturedLoggingProps = null;
    mockState.renderedCategoryIds = [];
  });

  test('builds native tools and stats from store state', async () => {
    mockState.nativeEnabledToolIds.add('native.search');
    renderPage();

    expect(mockState.capturedToolsOptions).not.toBeNull();
    const operations = mockState.capturedToolsOptions?.operations;
    expect(operations).toBeDefined();

    const tools = await operations?.getTools();
    expect(tools).toEqual([
      {
        id: 'native.search',
        source: 'native',
        category: 'retrieval',
        loadingTier: 'critical',
        description: 'Search local files and embeddings.',
        enabled: true,
        estimatedTokens: 1200,
        requiresApproval: false,
      },
      {
        id: 'native.write',
        source: 'native',
        category: 'action',
        loadingTier: 'conditional',
        description: 'Native tool: native.write',
        enabled: false,
        estimatedTokens: 400,
        requiresApproval: true,
      },
    ]);

    const stats = await operations?.getStats();
    expect(stats).toEqual({
      total: 2,
      enabled: 1,
      disabled: 1,
      bySource: { native: 2, mcp: 0 },
      byCategory: {
        retrieval: 1,
        action: 1,
        analysis: 0,
        configuration: 0,
        validation: 0,
      },
      mcpServers: 0,
    });
  });

  test('enables and disables only native tool ids', async () => {
    renderPage();
    const operations = mockState.capturedToolsOptions?.operations;
    expect(operations).toBeDefined();

    await operations?.enableTools(['native.search', 'mcp.remote']);
    expect(mockState.setToolsEnabledMock).toHaveBeenCalledWith(['native.search'], true);

    await operations?.disableTools(['native.write', 'mcp.other']);
    expect(mockState.setToolsEnabledMock).toHaveBeenCalledWith(['native.write'], false);

    await operations?.enableTools(['mcp.none']);
    await operations?.disableTools(['mcp.none']);
    expect(mockState.setToolsEnabledMock).toHaveBeenCalledTimes(2);
  });

  test('resets tools and reports unsupported tool execution in web mode', async () => {
    renderPage();
    const operations = mockState.capturedToolsOptions?.operations;
    expect(operations).toBeDefined();

    await operations?.resetTools();
    expect(mockState.resetToolsMock).toHaveBeenCalledTimes(1);

    const performanceNowSpy = vi
      .spyOn(performance, 'now')
      .mockReturnValueOnce(100.1)
      .mockReturnValueOnce(108.7);

    const result = await operations?.executeToolTest('native.search', { query: 'abc' });
    expect(result).toEqual({
      success: false,
      error:
        'Tool execution not yet implemented for native.search. Web app requires API integration for tool execution.',
      durationMs: 9,
    });

    performanceNowSpy.mockRestore();
  });

  test('wires logging source and factory reset callbacks from browser stores', async () => {
    mockState.storedFolders = ['/tmp/a'];
    mockState.devInlineFixtureEnabled = true;

    renderPage();

    expect(mockState.capturedFactoryResetOptions).toEqual(
      expect.objectContaining({
        isWebPlatform: true,
        hasStoredFolders: true,
        onClearStoredFolders: mockState.clearStoredHandlesMock,
      })
    );
    expect(mockState.capturedFactoryResetOptions?.inlineFixtureSetting?.checked).toBe(true);
    mockState.capturedFactoryResetOptions?.inlineFixtureSetting?.onChange(false);
    expect(mockState.setDevInlineFixtureEnabledMock).toHaveBeenCalledWith(false);

    mockState.capturedFactoryResetOptions?.onClearStoredFolders?.();
    expect(mockState.clearStoredHandlesMock).toHaveBeenCalledTimes(1);

    expect(mockState.capturedLoggingProps?.runtime).toBe('browser');
    const records = await mockState.capturedLoggingProps?.logSource.getInitialRecords();
    expect(Array.isArray(records)).toBe(true);
    const unsubscribe = mockState.capturedLoggingProps?.logSource.subscribe(() => undefined);
    expect(typeof unsubscribe).toBe('function');

    expect(mockState.renderedCategoryIds).toEqual([
      'appearance',
      'token-counting',
      'models',
      'logging',
      'tools',
      'diagnostics',
      'factory-reset',
    ]);
    expect(mockState.capturedToolsOptions?.mcpAvailable).toBe(false);
  });
});
