import {
  getNativeToolDescription,
  NATIVE_TOOL_DEFAULTS,
  SKILL_NATIVE_TOOL_IDS,
  type ToolCategory,
  type ToolLoadingTier,
  WEB_NATIVE_TOOL_IDS,
} from '@brainstrike/agent/tool-metadata';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
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
  executeToolTest?: (
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
  capturedFactoryResetOptions: null as CapturedFactoryResetOptions | null,
  capturedLoggingProps: null as CapturedLoggingProps | null,
  capturedToolsOptions: null as CapturedToolsOptions | null,
  clearStoredHandlesMock: vi.fn<() => void>(),
  devInlineFixtureEnabled: false,
  nativeEnabledToolIds: new Set<string>(),
  renderedCategoryIds: [] as string[],
  resetToolsMock: vi.fn<() => void>(),
  setDevInlineFixtureEnabledMock: vi.fn<(checked: boolean) => void>(),
  setToolsEnabledMock: vi.fn<(toolIds: string[], enabled: boolean) => void>(),
  storedFolders: [] as string[],
}));

vi.mock('@brainstrike/app-shell/diagnostics', () => ({
  createSystemDiagnosticsSettingsCategory: (): MockSettingsCategory => ({
    content: <div data-testid="diagnostics-category" />,
    id: 'diagnostics',
    title: 'Diagnostics',
  }),
  useDiagnosticSinkHealthStore: () => null,
  useDiagnosticsPurge: () => undefined,
  useDurableLogSource: () => undefined,
}));

vi.mock('@brainstrike/app-shell/cost-tracking-settings', () => ({
  createCostTrackingSettingsCategory: (): MockSettingsCategory => ({
    content: <div data-testid="cost-tracking-category" />,
    id: 'cost-tracking',
    title: 'Cost Tracking',
  }),
}));

vi.mock('@brainstrike/file-explorer-hooks', () => ({
  useRestoreAccess: () => ({
    beginRestore: vi.fn(),
    chooseDifferentFolder: vi.fn(),
    clearStoredHandles: mockState.clearStoredHandlesMock,
    dismissRestore: vi.fn(),
    isCheckingStoredHandles: false,
    pendingRestore: null,
    showDeniedBanner: false,
    showStaleBanner: false,
    storedFolders: mockState.storedFolders,
  }),
}));

vi.mock('@brainstrike/file-explorer-ui/shell', () => ({
  useFileExplorerStoreContext: () => (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      devInlineFixtureEnabled: mockState.devInlineFixtureEnabled,
      setDevInlineFixtureEnabled: mockState.setDevInlineFixtureEnabledMock,
    }),
  useFileExplorerStoreSelector: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      devInlineFixtureEnabled: mockState.devInlineFixtureEnabled,
      setDevInlineFixtureEnabled: mockState.setDevInlineFixtureEnabledMock,
    }),
}));

vi.mock('@brainstrike/file-explorer-ui/indexing', () => ({
  useOptionalTokenCacheContext: () => null,
}));

vi.mock('@brainstrike/settings-ui/settings-page-content', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@brainstrike/settings-ui/settings-page-content')>();
  return {
    ...actual,
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

vi.mock('@brainstrike/settings-ui/settings-category-factories', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@brainstrike/settings-ui/settings-category-factories')>();
  return {
    ...actual,
    createAppearanceSettingsCategory: (): MockSettingsCategory => ({
      content: <div data-testid="appearance-category" />,
      id: 'appearance',
      title: 'Appearance',
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
    createTokenCountingSettingsCategoryWithRuntimeSupport: (): MockSettingsCategory => ({
      content: <div data-testid="token-counting-category" />,
      id: 'token-counting',
      title: 'Token Counting',
    }),
  };
});

vi.mock('@brainstrike/app-state/stores/native-tool-preferences-store', () => ({
  useNativeToolPreferencesStore: {
    getState: () => ({
      isToolEnabled: (toolId: string) => mockState.nativeEnabledToolIds.has(toolId),
      resetTools: mockState.resetToolsMock,
      setToolsEnabled: mockState.setToolsEnabledMock,
    }),
  },
}));

vi.mock('@brainstrike/settings-ui/settings/tools/index', () => ({
  createToolsSettingsCategory: (options: CapturedToolsOptions): MockSettingsCategory => {
    mockState.capturedToolsOptions = options;
    return {
      content: <div data-testid="tools-category" />,
      id: 'ai-tools',
      title: 'AI Tools',
    };
  },
}));

vi.mock('@brainstrike/settings-ui/settings/system/logging-settings-section', () => ({
  LoggingSettingsSection: (props: CapturedLoggingProps) => {
    mockState.capturedLoggingProps = props;
    return <div data-testid="logging-settings-section" />;
  },
}));

vi.mock('@brainstrike/settings-ui/settings/models/model-selection-page', () => ({
  ModelSelectionPage: () => <div data-testid="model-selection-page" />,
}));

const renderPage = () => render(<SettingsPageContent />);

function getNativeToolIdAt(index: number): string {
  const id = WEB_NATIVE_TOOL_IDS[index];
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
    const expectedTools: MockToolDisplayMetadata[] = WEB_NATIVE_TOOL_IDS.map((id) => {
      const metadata = NATIVE_TOOL_DEFAULTS[id];
      return {
        category: metadata.category,
        description: getNativeToolDescription(id) ?? `Native tool: ${id}`,
        enabled: id === enabledToolId,
        estimatedTokens: metadata.estimatedTokens,
        id,
        loadingTier: metadata.loadingTier,
        requiresApproval: metadata.requiresApproval,
        source: 'native',
      };
    });
    expect(tools).toEqual(expectedTools);
    expect(tools?.map((tool) => tool.id)).not.toEqual(
      expect.arrayContaining([...SKILL_NATIVE_TOOL_IDS])
    );

    const stats = await operations?.getStats();
    const byCategory: Record<ToolCategory, number> = {
      action: expectedTools.filter((tool) => tool.category === 'action').length,
      analysis: expectedTools.filter((tool) => tool.category === 'analysis').length,
      configuration: expectedTools.filter((tool) => tool.category === 'configuration').length,
      retrieval: expectedTools.filter((tool) => tool.category === 'retrieval').length,
      validation: expectedTools.filter((tool) => tool.category === 'validation').length,
    };
    expect(stats).toEqual({
      byCategory,
      bySource: { mcp: 0, native: expectedTools.length },
      disabled: expectedTools.length - 1,
      enabled: 1,
      mcpServers: 0,
      total: expectedTools.length,
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

  test('resets tools without exposing a permanently unsupported web playground', async () => {
    renderPage();
    const operations = mockState.capturedToolsOptions?.operations;
    expect(operations).toBeDefined();

    await operations?.resetTools();
    expect(mockState.resetToolsMock).toHaveBeenCalledTimes(1);

    expect(operations?.executeToolTest).toBeUndefined();
  });

  test('wires logging source and factory reset callbacks from browser stores', async () => {
    mockState.storedFolders = ['/tmp/a'];
    mockState.devInlineFixtureEnabled = true;

    renderPage();

    expect(mockState.capturedFactoryResetOptions).toEqual(
      expect.objectContaining({
        hasStoredFolders: true,
        isWebPlatform: true,
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
      'providers',
      'models',
      'logging',
      'ai-tools',
      'permissions',
      'subagents',
      'notifications',
      'diagnostics',
      'factory-reset',
    ]);
    expect(mockState.capturedToolsOptions?.mcpAvailable).toBe(false);
  });
});
