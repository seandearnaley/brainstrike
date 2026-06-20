import {
  NATIVE_TOOL_DEFAULTS,
  TOOL_DESCRIPTIONS,
  type ToolCategory,
  type ToolLoadingTier,
} from '@brainstrike/agent/tool-metadata';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { HelmetProvider } from 'react-helmet-async';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import SettingsPageContent from '../page-content';

interface MockToolDisplayMetadata {
  category: ToolCategory;
  description: string;
  enabled: boolean;
  estimatedTokens: number;
  id: string;
  loadingTier: ToolLoadingTier;
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
    byCategory: Record<ToolCategory, number>;
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
  content: ReactNode;
  id: string;
  title: string;
}

const mockState = vi.hoisted(() => ({
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

vi.mock('@brainstrike/app-shell/diagnostics', () => ({
  createSystemDiagnosticsSettingsCategory: (): MockSettingsCategory => ({
    id: 'diagnostics',
    title: 'Diagnostics',
    content: <div data-testid="diagnostics-category" />,
  }),
}));

vi.mock('@brainstrike/app-shell/cost-tracking', () => ({
  createCostTrackingSettingsCategory: (): MockSettingsCategory => ({
    id: 'cost-tracking',
    title: 'Cost Tracking',
    content: <div data-testid="cost-tracking-category" />,
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

vi.mock('@brainstrike/file-explorer-ui/shell', () => ({
  useFileExplorerStoreSelector: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      devInlineFixtureEnabled: mockState.devInlineFixtureEnabled,
      setDevInlineFixtureEnabled: mockState.setDevInlineFixtureEnabledMock,
    }),
  useFileExplorerStoreContext: () => (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      devInlineFixtureEnabled: mockState.devInlineFixtureEnabled,
      setDevInlineFixtureEnabled: mockState.setDevInlineFixtureEnabledMock,
    }),
}));

vi.mock('@brainstrike/file-explorer-ui/indexing', () => ({
  useOptionalTokenCacheContext: () => null,
}));

vi.mock('@brainstrike/preferences/settings-page-content', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@brainstrike/preferences/settings-page-content')>();
  return {
    ...actual,
    createAppearanceSettingsCategory: (): MockSettingsCategory => ({
      content: <div data-testid="appearance-category" />,
      id: 'appearance',
      title: 'Appearance',
    }),
    createTokenCountingSettingsCategoryWithRuntimeSupport: (): MockSettingsCategory => ({
      content: <div data-testid="token-counting-category" />,
      id: 'token-counting',
      title: 'Token Counting',
    }),
    createFactoryResetSettingsCategory: (
      options?: CapturedFactoryResetOptions
    ): MockSettingsCategory => {
      mockState.capturedFactoryResetOptions = options ?? null;
      return {
        content: <div data-testid="factory-reset-category" />,
        id: 'factory-reset',
        title: 'Factory Reset',
      };
    },
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
              {category.content}
            </section>
          ))}
        </div>
      );
    },
  };
});

vi.mock('@brainstrike/preferences/stores/native-tool-preferences-store', () => ({
  useNativeToolPreferencesStore: {
    getState: () => ({
      isToolEnabled: (toolId: string) => mockState.nativeEnabledToolIds.has(toolId),
      setToolsEnabled: mockState.setToolsEnabledMock,
      resetTools: mockState.resetToolsMock,
    }),
  },
}));

vi.mock('@brainstrike/preferences/settings/tools/index', () => ({
  createToolsSettingsCategory: (options: CapturedToolsOptions): MockSettingsCategory => {
    mockState.capturedToolsOptions = options;
    return {
      content: <div data-testid="tools-category" />,
      id: 'ai-tools',
      title: 'AI Tools',
    };
  },
}));

vi.mock('@brainstrike/preferences/settings/system/logging-settings-section', () => ({
  LoggingSettingsSection: (props: CapturedLoggingProps) => {
    mockState.capturedLoggingProps = props;
    return <div data-testid="logging-settings-section" />;
  },
}));

vi.mock('@brainstrike/preferences/settings/models/model-selection-page', () => ({
  ModelSelectionPage: () => <div data-testid="model-selection-page" />,
}));

const renderPage = () =>
  render(
    <HelmetProvider>
      <SettingsPageContent />
    </HelmetProvider>
  );

function getNativeToolIdAt(index: number): string {
  const id = Object.keys(NATIVE_TOOL_DEFAULTS)[index];
  if (id === undefined) {
    throw new Error(`Expected native tool at index ${index}`);
  }
  return id;
}

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
    const enabledToolId = getNativeToolIdAt(0);
    mockState.nativeEnabledToolIds.add(enabledToolId);
    renderPage();

    expect(mockState.capturedToolsOptions).not.toBeNull();
    const operations = mockState.capturedToolsOptions?.operations;
    expect(operations).toBeDefined();

    const tools = await operations?.getTools();
    const expectedTools: MockToolDisplayMetadata[] = Object.entries(NATIVE_TOOL_DEFAULTS).map(
      ([id, metadata]) => ({
        id,
        source: 'native',
        category: metadata.category,
        loadingTier: metadata.loadingTier,
        description: TOOL_DESCRIPTIONS[id] ?? `Native tool: ${id}`,
        enabled: id === enabledToolId,
        estimatedTokens: metadata.estimatedTokens,
        requiresApproval: metadata.requiresApproval,
      })
    );
    expect(tools).toEqual(expectedTools);

    const stats = await operations?.getStats();
    const byCategory: Record<ToolCategory, number> = {
      retrieval: expectedTools.filter((tool) => tool.category === 'retrieval').length,
      action: expectedTools.filter((tool) => tool.category === 'action').length,
      analysis: expectedTools.filter((tool) => tool.category === 'analysis').length,
      configuration: expectedTools.filter((tool) => tool.category === 'configuration').length,
      validation: expectedTools.filter((tool) => tool.category === 'validation').length,
    };
    expect(stats).toEqual({
      total: expectedTools.length,
      enabled: 1,
      disabled: expectedTools.length - 1,
      bySource: { native: expectedTools.length, mcp: 0 },
      byCategory,
      mcpServers: 0,
    });
  });

  test('enables and disables only native tool ids', async () => {
    const enabledToolId = getNativeToolIdAt(0);
    const disabledToolId = getNativeToolIdAt(1);
    renderPage();
    const operations = mockState.capturedToolsOptions?.operations;
    expect(operations).toBeDefined();

    await operations?.enableTools([enabledToolId, 'mcp.remote']);
    expect(mockState.setToolsEnabledMock).toHaveBeenCalledWith([enabledToolId], true);

    await operations?.disableTools([disabledToolId, 'mcp.other']);
    expect(mockState.setToolsEnabledMock).toHaveBeenCalledWith([disabledToolId], false);

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

    const toolId = getNativeToolIdAt(0);
    const result = await operations?.executeToolTest(toolId, { query: 'abc' });
    expect(result).toEqual({
      success: false,
      error: `Tool execution not yet implemented for ${toolId}. Web app requires API integration for tool execution.`,
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
      'search-indexing',
      'token-counting',
      'cost-tracking',
      'local-runtimes',
      'models',
      'logging',
      'ai-tools',
      'permissions',
      'diagnostics',
      'factory-reset',
    ]);
    expect(mockState.capturedToolsOptions?.mcpAvailable).toBe(false);
  });
});
