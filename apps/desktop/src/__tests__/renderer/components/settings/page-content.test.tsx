import { DESKTOP_NATIVE_TOOL_IDS } from '@brainstrike/agent/client';
import { __resetAssistantPreferencesStoreForTests } from '@brainstrike/app-state/stores/assistant-preferences-store';
import { __resetNativeToolPreferencesStoreForTests } from '@brainstrike/app-state/stores/native-tool-preferences-store';
import type { ProviderKeySource } from '@brainstrike/assistant-contract';
import type { SupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import { ThemeProvider, type ThemeStorageAdapter, TooltipProvider } from '@brainstrike/ui';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import SettingsPageContent from '../../../../renderer/components/settings/page-content';

const themeStorageAdapter: ThemeStorageAdapter = {
  getItem: async () => null,
  setItem: async () => {},
};

// Mock file-explorer-ui - needed for useFileExplorerStoreContext
vi.mock('@brainstrike/file-explorer-ui/shell', () => ({
  FileExplorerProvider: ({ children }: { children: React.ReactNode }) => children,
  useFileExplorerStoreContext: () => {
    // Return a mock store function that returns default values
    const mockStore = (selector: (state: Record<string, unknown>) => unknown) => {
      const mockState = {
        activeRootIds: [],
        devInlineFixtureEnabled: false,
        rootDescriptors: {},
        setDevInlineFixtureEnabled: vi.fn(),
      };
      return selector(mockState);
    };
    return mockStore;
  },
  useFileExplorerStoreSelector: (selector: (state: Record<string, unknown>) => unknown) => {
    const mockState = {
      activeRootIds: [],
      devInlineFixtureEnabled: false,
      rootDescriptors: {},
      setDevInlineFixtureEnabled: vi.fn(),
    };
    return selector(mockState);
  },
}));

vi.mock('@brainstrike/file-explorer-ui/indexing', () => ({
  useOptionalTokenCacheContext: () => null,
}));

interface SecretsApi {
  clearAll?: () => Promise<{ success: boolean; message?: string }>;
  deleteKey: (provider: string) => Promise<void>;
  getKey: (provider: string) => Promise<string | null>;
  list: () => Promise<ProviderKeySource<SupportedProvider | 'tavily'>[]>;
  listStored: () => Promise<string[]>;
  saveKey: (provider: string, key: string) => Promise<{ ok?: boolean; error?: string } | undefined>;
}

interface McpApi {
  disableServerTools: (serverName: string) => Promise<void>;
  disableTools: (ids: string[]) => Promise<void>;
  enableServerTools: (serverName: string) => Promise<void>;
  enableTools: (ids: string[]) => Promise<void>;
  getConfig: () => Promise<{ path: string; exists: boolean; servers: never[] }>;
  getPath?: () => Promise<string>;
  getServerStatusSnapshot: () => Promise<{ revision: number; servers: never[] }>;
  getToolStats: () => Promise<{
    total: number;
    enabled: number;
    disabled: number;
    servers: number;
  }>;
  listTools: () => Promise<Record<string, never[]>>;
  onConfigUpdated: (
    listener: (config: { error?: string; exists: boolean; path: string }) => void
  ) => () => void;
  onServerStatusUpdated: (
    listener: (snapshot: { revision: number; servers: never[] }) => void
  ) => () => void;
  onToolsUpdated: (listener: (tools: unknown) => void) => () => void;
  readConfigText?: () => Promise<{
    path: string;
    exists: boolean;
    created: boolean;
    content: string;
  }>;
  resetTools: () => Promise<void>;
  selectPath: () => Promise<string | null>;
  setPath: (path: string | null) => Promise<{ success: boolean; path: string }>;
  writeConfigText?: (
    content: string
  ) => Promise<{ success: true; path: string } | { success: false; path: string; error: string }>;
}

const getWindowWithExtensions = () =>
  window as unknown as Omit<typeof window, 'mcp' | 'secrets'> & {
    secrets?: SecretsApi;
    mcp?: McpApi;
  };

let originalResizeObserver: typeof ResizeObserver | undefined;

beforeAll(() => {
  originalResizeObserver = (globalThis as unknown as { ResizeObserver?: typeof ResizeObserver })
    .ResizeObserver;
  class ResizeObserverPolyfill {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
    ResizeObserverPolyfill as unknown as typeof ResizeObserver;
});

afterAll(() => {
  if (originalResizeObserver) {
    (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
      originalResizeObserver;
  } else {
    // biome-ignore lint/performance/noDelete: cleanup
    delete (globalThis as unknown as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
  }
});

beforeEach(() => {
  window.location.hash = '';

  const secrets: SecretsApi = {
    deleteKey: vi.fn().mockResolvedValue(undefined),
    getKey: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue([]),
    listStored: vi.fn().mockResolvedValue([]),
    saveKey: vi.fn().mockResolvedValue(true),
  };

  const mcp: McpApi = {
    disableServerTools: vi.fn().mockResolvedValue(undefined),
    disableTools: vi.fn().mockResolvedValue(undefined),
    enableServerTools: vi.fn().mockResolvedValue(undefined),
    enableTools: vi.fn().mockResolvedValue(undefined),
    getConfig: vi.fn().mockResolvedValue({ exists: true, path: '/tmp/mcp.json', servers: [] }),
    getPath: vi.fn().mockResolvedValue('/tmp/mcp.json'),
    getServerStatusSnapshot: vi.fn().mockResolvedValue({ revision: 0, servers: [] }),
    getToolStats: vi.fn().mockResolvedValue({ disabled: 0, enabled: 0, servers: 0, total: 0 }),
    listTools: vi.fn().mockResolvedValue({}),
    onConfigUpdated: vi.fn(() => vi.fn()),
    onServerStatusUpdated: vi.fn(() => vi.fn()),
    onToolsUpdated: vi.fn(() => vi.fn()),
    readConfigText: vi.fn().mockResolvedValue({
      content: '{\n  "servers": []\n}',
      created: false,
      exists: true,
      path: '/tmp/mcp.json',
    }),
    resetTools: vi.fn().mockResolvedValue(undefined),
    selectPath: vi.fn().mockResolvedValue(null),
    setPath: vi.fn().mockResolvedValue({ path: '/tmp/mcp.json', success: true }),
    writeConfigText: vi.fn().mockResolvedValue({ path: '/tmp/mcp.json', success: true }),
  };

  const extendedWindow = getWindowWithExtensions();
  extendedWindow.secrets = secrets;
  extendedWindow.mcp = mcp;

  __resetAssistantPreferencesStoreForTests();
  __resetNativeToolPreferencesStoreForTests();
});

afterEach(() => {
  const extendedWindow = getWindowWithExtensions();
  // Reset to undefined instead of deleting - safer for environments where props may not be configurable
  extendedWindow.secrets = undefined as unknown as SecretsApi | undefined;
  extendedWindow.mcp = undefined as unknown as McpApi | undefined;
});

describe('Desktop SettingsPageContent', () => {
  it('navigates to AI Tools and displays unified tools management', async () => {
    render(
      <ThemeProvider storageAdapter={themeStorageAdapter}>
        <TooltipProvider>
          <SettingsPageContent />
        </TooltipProvider>
      </ThemeProvider>
    );

    const toolsButton = await screen.findByRole('button', { name: /AI Tools/i });
    fireEvent.click(toolsButton);

    const toolsPane = await screen.findByTestId('settings-category-ai-tools');
    const expectedEnabledCount = DESKTOP_NATIVE_TOOL_IDS.length;
    // Should show the unified tools settings with stats (all native tools enabled by default)
    // Use getAllByText since "enabled" appears in both stats bar and group headers
    const enabledElements = await within(toolsPane).findAllByText(
      new RegExp(`${expectedEnabledCount} enabled`, 'i')
    );
    expect(enabledElements.length).toBeGreaterThan(0);
    expect(within(toolsPane).queryByTestId('tool-row-skill')).not.toBeInTheDocument();
    expect(within(toolsPane).queryByTestId('tool-row-skill_read')).not.toBeInTheDocument();
    expect(within(toolsPane).queryByTestId('tool-row-skill_search')).not.toBeInTheDocument();
  });

  it('renders Assistant Memory and the subagent budgets in their own categories', async () => {
    render(
      <ThemeProvider storageAdapter={themeStorageAdapter}>
        <TooltipProvider>
          <SettingsPageContent />
        </TooltipProvider>
      </ThemeProvider>
    );

    const nav = await screen.findByRole('navigation', { name: /settings categories/i });
    fireEvent.click(within(nav).getByRole('button', { name: /^Assistant Memory$/i }));
    const memoryPane = await screen.findByTestId('settings-category-assistant-memory');
    expect(within(memoryPane).getByTestId('assistant-memory-settings-section')).toBeInTheDocument();

    fireEvent.click(within(nav).getByRole('button', { name: /^Subagents$/i }));
    const subagentsPane = await screen.findByTestId('settings-category-subagents');
    expect(within(subagentsPane).getByTestId('subagent-settings-section')).toBeInTheDocument();
  });

  it('filters categories using the search box', async () => {
    render(
      <ThemeProvider storageAdapter={themeStorageAdapter}>
        <TooltipProvider>
          <SettingsPageContent />
        </TooltipProvider>
      </ThemeProvider>
    );

    const searchbox = await screen.findByRole('searchbox', { name: /Search settings/i });
    fireEvent.change(searchbox, { target: { value: 'tools' } });

    expect(await screen.findByRole('button', { name: /AI Tools/i })).toBeInTheDocument();

    fireEvent.change(searchbox, { target: { value: 'unknown' } });
    expect(screen.getByText(/No settings matched "unknown"/i)).toBeInTheDocument();
  });

  it('shows Factory Reset category when searching for factory', async () => {
    render(
      <ThemeProvider storageAdapter={themeStorageAdapter}>
        <TooltipProvider>
          <SettingsPageContent />
        </TooltipProvider>
      </ThemeProvider>
    );

    const searchbox = await screen.findByRole('searchbox', { name: /Search settings/i });
    fireEvent.change(searchbox, { target: { value: 'factory' } });

    const nav = screen.getByRole('navigation', { name: /settings categories/i });
    expect(await within(nav).findByRole('button', { name: /Factory Reset/i })).toBeInTheDocument();
  });

  it('registers Workspace with the live worktree capability status', async () => {
    render(
      <ThemeProvider storageAdapter={themeStorageAdapter}>
        <TooltipProvider>
          <SettingsPageContent />
        </TooltipProvider>
      </ThemeProvider>
    );

    const nav = await screen.findByRole('navigation', { name: /settings categories/i });
    fireEvent.click(await within(nav).findByRole('button', { name: /^Workspace$/i }));

    expect(await screen.findByTestId('worktree-settings-unavailable')).toHaveTextContent(
      'Worktrees are a desktop feature'
    );
  });

  it('renders the Provider Hub, not a separate API Keys category', async () => {
    render(
      <ThemeProvider storageAdapter={themeStorageAdapter}>
        <TooltipProvider>
          <SettingsPageContent />
        </TooltipProvider>
      </ThemeProvider>
    );

    const nav = await screen.findByRole('navigation', { name: /settings categories/i });
    // BST-1358 replaced "API Keys" + "Models & Providers" with one surface.
    expect(within(nav).queryByRole('button', { name: /^API Keys$/i })).not.toBeInTheDocument();

    // findByRole throws on multiple matches, so this also guards against a duplicate registration.
    const providersButton = await within(nav).findByRole('button', { name: /^Providers$/i });
    fireEvent.click(providersButton);

    expect(window.location.hash).toBe('#settings/providers');

    expect(await screen.findByTestId('providers-settings')).toBeInTheDocument();
    // Cards are grouped by provider runtime, exactly as the model picker groups.
    expect(await screen.findByTestId('provider-card-openai')).toBeInTheDocument();
    expect(screen.getByTestId('provider-group-hosted')).toBeInTheDocument();
  });
});
vi.mock('@brainstrike/settings-ui/settings-category-factories', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@brainstrike/settings-ui/settings-category-factories')>();
  return {
    ...actual,
    createSearchIndexingSettingsCategory: vi.fn(() => ({
      content: <div data-testid="search-indexing-settings-mock" />,
      id: 'search-indexing',
      title: 'Search & Indexing',
    })),
    createTokenCountingSettingsCategoryWithRuntimeSupport: vi.fn(() => ({
      content: <div data-testid="token-counting-settings-mock" />,
      id: 'token-counting',
      title: 'Token Counting',
    })),
  };
});

vi.mock('@brainstrike/settings-ui/settings/models/model-selection-page', () => ({
  ModelCatalogHeaderActions: vi.fn(() => null),
  ModelSelectionPage: vi.fn(() => (
    <div data-testid="model-selection-page-mock">
      <h4>Provider API Keys</h4>
      <label htmlFor="provider-select">Provider</label>
      <select aria-label="Provider" id="provider-select" />
      <label htmlFor="api-key-input">API Key</label>
      <input aria-label="API Key" id="api-key-input" />
    </div>
  )),
}));
