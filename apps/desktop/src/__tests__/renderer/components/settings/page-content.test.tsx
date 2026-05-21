import { NATIVE_TOOL_DEFAULTS } from '@brainstrike/agent/client';
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
  useFileExplorerStoreSelector: (selector: (state: Record<string, unknown>) => unknown) => {
    const mockState = {
      devInlineFixtureEnabled: false,
      setDevInlineFixtureEnabled: vi.fn(),
    };
    return selector(mockState);
  },
  useFileExplorerStoreContext: () => {
    // Return a mock store function that returns default values
    const mockStore = (selector: (state: Record<string, unknown>) => unknown) => {
      const mockState = {
        devInlineFixtureEnabled: false,
        setDevInlineFixtureEnabled: vi.fn(),
      };
      return selector(mockState);
    };
    return mockStore;
  },
  FileExplorerProvider: ({ children }: { children: React.ReactNode }) => children,
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
    list: vi.fn().mockResolvedValue([]),
    listStored: vi.fn().mockResolvedValue([]),
    saveKey: vi.fn().mockResolvedValue(true),
    getKey: vi.fn().mockResolvedValue(null),
    deleteKey: vi.fn().mockResolvedValue(undefined),
  };

  const mcp: McpApi = {
    getConfig: vi.fn().mockResolvedValue({ path: '/tmp/mcp.json', exists: true, servers: [] }),
    getPath: vi.fn().mockResolvedValue('/tmp/mcp.json'),
    selectPath: vi.fn().mockResolvedValue(null),
    setPath: vi.fn().mockResolvedValue({ success: true, path: '/tmp/mcp.json' }),
    readConfigText: vi.fn().mockResolvedValue({
      path: '/tmp/mcp.json',
      exists: true,
      created: false,
      content: '{\n  "servers": []\n}',
    }),
    writeConfigText: vi.fn().mockResolvedValue({ success: true, path: '/tmp/mcp.json' }),
    listTools: vi.fn().mockResolvedValue({}),
    getToolStats: vi.fn().mockResolvedValue({ total: 0, enabled: 0, disabled: 0, servers: 0 }),
    disableTools: vi.fn().mockResolvedValue(undefined),
    enableTools: vi.fn().mockResolvedValue(undefined),
    enableServerTools: vi.fn().mockResolvedValue(undefined),
    disableServerTools: vi.fn().mockResolvedValue(undefined),
    resetTools: vi.fn().mockResolvedValue(undefined),
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
    const expectedEnabledCount = Object.keys(NATIVE_TOOL_DEFAULTS).length;
    // Should show the unified tools settings with stats (all native tools enabled by default)
    // Use getAllByText since "enabled" appears in both stats bar and group headers
    const enabledElements = await within(toolsPane).findAllByText(
      new RegExp(`${expectedEnabledCount} enabled`, 'i')
    );
    expect(enabledElements.length).toBeGreaterThan(0);
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
