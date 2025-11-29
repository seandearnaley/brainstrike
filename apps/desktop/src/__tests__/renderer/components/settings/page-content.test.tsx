import { __resetAssistantPreferencesStoreForTests } from '@brainstrike/preferences';
import { ThemeProvider } from '@brainstrike/ui';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import SettingsPageContent from '../../../../renderer/components/settings/page-content';

type SecretsApi = {
  list: () => Promise<string[]>;
  listStored: () => Promise<string[]>;
  saveKey: (provider: string, key: string) => Promise<{ ok?: boolean; error?: string } | undefined>;
  getKey: (provider: string) => Promise<string | null>;
  deleteKey: (provider: string) => Promise<void>;
  clearAll?: () => Promise<{ success: boolean; message?: string }>;
};

type McpApi = {
  getConfig: () => Promise<{ path: string; exists: boolean; servers: never[] }>;
  selectPath: () => Promise<string | null>;
  setPath: (path: string | null) => Promise<{ success: boolean; path: string }>;
  listTools: () => Promise<Record<string, never[]>>;
  getToolStats: () => Promise<{
    total: number;
    enabled: number;
    disabled: number;
    servers: number;
  }>;
  disableTools: (ids: string[]) => Promise<void>;
  enableTools: (ids: string[]) => Promise<void>;
  enableServerTools: (serverName: string) => Promise<void>;
  disableServerTools: (serverName: string) => Promise<void>;
  resetTools: () => Promise<void>;
};

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
    selectPath: vi.fn().mockResolvedValue(null),
    setPath: vi.fn().mockResolvedValue({ success: true, path: '/tmp/mcp.json' }),
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
});

afterEach(() => {
  const extendedWindow = getWindowWithExtensions();
  // biome-ignore lint/performance/noDelete: cleanup
  delete extendedWindow.secrets;
  // biome-ignore lint/performance/noDelete: cleanup
  delete extendedWindow.mcp;
});

describe('Desktop SettingsPageContent', () => {
  it('navigates to MCP integrations and displays tool management panels', async () => {
    render(
      <ThemeProvider>
        <SettingsPageContent />
      </ThemeProvider>
    );

    const mcpButton = await screen.findByRole('button', { name: /MCP Integrations/i });
    fireEvent.click(mcpButton);

    const mcpPane = await screen.findByTestId('settings-category-mcp-integrations');
    expect(
      await within(mcpPane).findByRole('heading', { name: /Model Context Protocol/i })
    ).toBeInTheDocument();
    const toolLabels = await within(mcpPane).findAllByText(/MCP Tools/i);
    expect(toolLabels.length).toBeGreaterThanOrEqual(2);
  });

  it('filters categories using the search box', async () => {
    render(
      <ThemeProvider>
        <SettingsPageContent />
      </ThemeProvider>
    );

    const searchbox = await screen.findByRole('searchbox', { name: /Search settings/i });
    fireEvent.change(searchbox, { target: { value: 'mcp' } });

    expect(await screen.findByRole('button', { name: /MCP Integrations/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Desktop Preferences/i })).not.toBeInTheDocument();

    fireEvent.change(searchbox, { target: { value: 'unknown' } });
    expect(screen.getByText(/No settings matched "unknown"/i)).toBeInTheDocument();
  });

  it('shows Factory Reset category when searching for factory', async () => {
    render(
      <ThemeProvider>
        <SettingsPageContent />
      </ThemeProvider>
    );

    const searchbox = await screen.findByRole('searchbox', { name: /Search settings/i });
    fireEvent.change(searchbox, { target: { value: 'factory' } });

    const nav = screen.getByRole('navigation', { name: /settings categories/i });
    expect(await within(nav).findByRole('button', { name: /Factory Reset/i })).toBeInTheDocument();
  });

  it('renders LLM credentials form fields in Models & Providers', async () => {
    render(
      <ThemeProvider>
        <SettingsPageContent />
      </ThemeProvider>
    );

    const modelsButton = await screen.findByRole('button', { name: /Models & Providers/i });
    fireEvent.click(modelsButton);

    expect(await screen.findByText(/Provider API Keys/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Provider')).toBeInTheDocument();
    expect(screen.getByLabelText('API Key')).toBeInTheDocument();
  });
});
vi.mock('@brainstrike/preferences', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/preferences')>();
  return {
    ...actual,
    EmbeddingSettings: vi.fn(() => <div data-testid="embedding-settings-mock" />),
  };
});
