import { ThemeProvider } from '@brainstrike/ui';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
});
