import {
  __resetAssistantPreferencesStoreForTests,
  useAssistantPreferencesStore,
} from '@brainstrike/preferences';
import { ThemeProvider } from '@brainstrike/ui';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import SettingsPageContent from '../../../../renderer/components/settings/page-content';

type SecretsApi = {
  list: () => Promise<string[]>;
  saveKey: (provider: string, key: string) => Promise<unknown>;
  getKey: (provider: string) => Promise<string | null>;
  deleteKey: (provider: string) => Promise<boolean>;
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
  (globalThis as unknown as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver =
    originalResizeObserver;
});

beforeEach(() => {
  window.location.hash = '';

  const secrets: SecretsApi = {
    list: vi.fn().mockResolvedValue([]),
    saveKey: vi.fn().mockResolvedValue(true),
    getKey: vi.fn().mockResolvedValue(null),
    deleteKey: vi.fn().mockResolvedValue(true),
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
  extendedWindow.secrets = undefined;
  extendedWindow.mcp = undefined;
});

describe('Desktop SettingsPageContent', () => {
  it('renders categories and shows desktop preferences content', async () => {
    render(
      <ThemeProvider>
        <SettingsPageContent />
      </ThemeProvider>
    );

    const desktopButton = await screen.findByRole('button', { name: /Desktop Preferences/i });
    fireEvent.click(desktopButton);
    const desktopPane = await screen.findByTestId('settings-category-desktop-preferences');
    expect(within(desktopPane).getByText(/Secure Provider Credentials/i)).toBeInTheDocument();
    expect(within(desktopPane).getByText(/LLM Provider Keys/i)).toBeInTheDocument();
  });

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

  it('renders LLM credentials form fields in Desktop Preferences', async () => {
    render(
      <ThemeProvider>
        <SettingsPageContent />
      </ThemeProvider>
    );

    const preferencesButton = await screen.findByRole('button', { name: /Desktop Preferences/i });
    fireEvent.click(preferencesButton);

    expect(await screen.findByLabelText('Provider')).toBeInTheDocument();
    expect(screen.getByLabelText('API Key')).toBeInTheDocument();
    expect(await screen.findByText('Saved Providers')).toBeInTheDocument();
  });

  it('shows model availability controls with search input', async () => {
    render(
      <ThemeProvider>
        <SettingsPageContent />
      </ThemeProvider>
    );

    const preferencesButton = await screen.findByRole('button', { name: /Desktop Preferences/i });
    fireEvent.click(preferencesButton);

    expect(await screen.findByText(/Model Availability/i)).toBeInTheDocument();
    expect(await screen.findByLabelText('Search models')).toBeInTheDocument();
  });

  it('renders embedding settings panel when category is selected', async () => {
    render(
      <ThemeProvider>
        <SettingsPageContent />
      </ThemeProvider>
    );

    const embeddingButton = await screen.findByRole('button', { name: /Embedding Models/i });
    fireEvent.click(embeddingButton);

    const pane = await screen.findByTestId('settings-category-embedding-models');
    expect(within(pane).getByTestId('embedding-settings-mock')).toBeInTheDocument();
  });

  it('allows toggling model availability for a provider', async () => {
    render(
      <ThemeProvider>
        <SettingsPageContent />
      </ThemeProvider>
    );

    const preferencesButton = await screen.findByRole('button', { name: /Desktop Preferences/i });
    fireEvent.click(preferencesButton);

    const toggle = await screen.findByTestId('model-toggle-openai-gpt-4o-mini');
    expect(toggle).toHaveAttribute('data-state', 'checked');

    fireEvent.click(toggle);

    const updatedToggle = await screen.findByTestId('model-toggle-openai-gpt-4o-mini');
    expect(updatedToggle).toHaveAttribute('data-state', 'unchecked');
    expect(
      useAssistantPreferencesStore
        .getState()
        .enabledModelsByProvider.openai?.includes('gpt-4o-mini')
    ).toBe(false);
  });

  it('filters provider models based on search term', async () => {
    render(
      <ThemeProvider>
        <SettingsPageContent />
      </ThemeProvider>
    );

    const preferencesButton = await screen.findByRole('button', { name: /Desktop Preferences/i });
    fireEvent.click(preferencesButton);

    const searchbox = await screen.findByLabelText('Search models');
    fireEvent.change(searchbox, { target: { value: 'claude' } });

    const anthropicSection = await screen.findByTestId('provider-model-section-anthropic');
    expect(anthropicSection).toBeInTheDocument();
    expect(screen.queryByTestId('provider-model-section-openai')).not.toBeInTheDocument();

    fireEvent.change(searchbox, { target: { value: 'no-such-model' } });
    expect(await screen.findByText(/No providers match the current search/i)).toBeInTheDocument();
  });

  it('supports bulk enable actions for all models', async () => {
    render(
      <ThemeProvider>
        <SettingsPageContent />
      </ThemeProvider>
    );

    const preferencesButton = await screen.findByRole('button', { name: /Desktop Preferences/i });
    fireEvent.click(preferencesButton);

    const toggle = await screen.findByTestId('model-toggle-openai-gpt-4o-mini');
    fireEvent.click(toggle);
    expect(
      useAssistantPreferencesStore
        .getState()
        .enabledModelsByProvider.openai?.includes('gpt-4o-mini')
    ).toBe(false);

    const enableAll = await screen.findByTestId('enable-all-models');
    fireEvent.click(enableAll);

    await waitFor(() => {
      expect(
        useAssistantPreferencesStore
          .getState()
          .enabledModelsByProvider.openai?.includes('gpt-4o-mini')
      ).toBe(true);
    });
  });
});
vi.mock('@brainstrike/preferences', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/preferences')>();
  return {
    ...actual,
    EmbeddingSettings: vi.fn(() => <div data-testid="embedding-settings-mock" />),
  };
});
