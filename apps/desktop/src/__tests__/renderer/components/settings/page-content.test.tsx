import { DESKTOP_NATIVE_TOOL_IDS } from '@brainstrike/agent/client';
import {
  __resetAssistantPreferencesStoreForTests,
  __resetNativeToolPreferencesStoreForTests,
} from '@brainstrike/preferences';
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
  list: () => Promise<string[]>;
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
  getToolStats: () => Promise<{
    total: number;
    enabled: number;
    disabled: number;
    servers: number;
  }>;
  listTools: () => Promise<Record<string, never[]>>;
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
  window as typeof window & { secrets?: SecretsApi; mcp?: McpApi };

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
    getToolStats: vi.fn().mockResolvedValue({ disabled: 0, enabled: 0, servers: 0, total: 0 }),
    listTools: vi.fn().mockResolvedValue({}),
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

  it('renders LLM credentials form fields in Models & Providers', async () => {
    render(
      <ThemeProvider storageAdapter={themeStorageAdapter}>
        <TooltipProvider>
          <SettingsPageContent />
        </TooltipProvider>
      </ThemeProvider>
    );

    const modelsButton = await screen.findByRole('button', { name: /Models & Providers/i });
    fireEvent.click(modelsButton);

    expect(await screen.findByText(/Provider API Keys/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Provider')).toBeInTheDocument();
    expect(screen.getByLabelText('API Key')).toBeInTheDocument();
  });
});
vi.mock('@brainstrike/preferences/settings-page-content', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@brainstrike/preferences/settings-page-content')>();
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

vi.mock('@brainstrike/preferences/settings/models/model-selection-page', () => ({
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
