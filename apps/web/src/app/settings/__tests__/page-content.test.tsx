import { __resetNativeToolPreferencesStoreForTests } from '@brainstrike/app-state/stores/native-tool-preferences-store';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import SettingsPageContent from '../page-content';

vi.mock('@brainstrike/settings-ui/settings/models/model-selection-page', () => ({
  ModelCatalogHeaderActions: vi.fn(() => null),
  ModelSelectionPage: vi.fn(() => <div data-testid="model-selection-page-mock" />),
}));

vi.mock('@brainstrike/settings-ui/settings-category-factories', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@brainstrike/settings-ui/settings-category-factories')>();
  return {
    ...actual,
    createAppearanceSettingsCategory: vi.fn(() => ({
      content: <div data-testid="appearance-category-mock">Theme Settings Mock</div>,
      description: 'Appearance settings',
      id: 'appearance',
      keywords: ['appearance'],
      title: 'Appearance',
    })),
  };
});

vi.mock('@brainstrike/file-explorer-hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/file-explorer-hooks')>();
  return {
    ...actual,
    useRestoreAccess: vi.fn(() => ({
      beginRestore: vi.fn(),
      chooseDifferentFolder: vi.fn(),
      clearStoredHandles: vi.fn(),
      dismissRestore: vi.fn(),
      isCheckingStoredHandles: false,
      pendingRestore: null,
      showDeniedBanner: false,
      showStaleBanner: false,
      storedFolders: [],
    })),
  };
});

vi.mock('@brainstrike/file-explorer-ui/shell', () => ({
  FileExplorerProvider: ({ children }: { children: React.ReactNode }) => children,
  useFileExplorerStoreContext: () => {
    const mockStore = (selector: (state: Record<string, unknown>) => unknown) => {
      const mockState = {
        devInlineFixtureEnabled: false,
        setDevInlineFixtureEnabled: vi.fn(),
      };
      return selector(mockState);
    };
    return mockStore;
  },
  useFileExplorerStoreSelector: (selector: (state: Record<string, unknown>) => unknown) => {
    const mockState = {
      devInlineFixtureEnabled: false,
      setDevInlineFixtureEnabled: vi.fn(),
    };
    return selector(mockState);
  },
}));

vi.mock('@brainstrike/file-explorer-ui/indexing', () => ({
  useOptionalTokenCacheContext: () => null,
}));

describe('Web SettingsPageContent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = '';
    __resetNativeToolPreferencesStoreForTests();
  });

  const renderPage = () => render(<SettingsPageContent />);

  test('renders navigation and defaults to appearance category', () => {
    renderPage();

    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Appearance' })).toBeInTheDocument();

    const nav = screen.getByRole('navigation', { name: /settings categories/i });
    const appearanceButton = within(nav).getByRole('button', { name: /Appearance/i });
    expect(appearanceButton).toHaveAttribute('aria-current', 'page');

    expect(screen.getByTestId('appearance-category-mock')).toBeInTheDocument();
    expect(window.location.hash).toBe('#settings/appearance');
  });

  test('filters categories with the settings search input', () => {
    renderPage();

    const searchbox = screen.getByRole('searchbox', { name: /search settings/i });
    fireEvent.change(searchbox, { target: { value: 'factory' } });

    const nav = screen.getByRole('navigation', { name: /settings categories/i });
    expect(within(nav).getByRole('button', { name: /Factory Reset/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Appearance/i })).not.toBeInTheDocument();

    fireEvent.change(searchbox, { target: { value: 'missing' } });
    expect(screen.getByText(/No settings matched "missing"/i)).toBeInTheDocument();
  });

  test('registers the Provider Hub without a separate API Keys category', async () => {
    renderPage();

    const nav = screen.getByRole('navigation', { name: /settings categories/i });
    expect(within(nav).queryByRole('button', { name: /^API Keys$/i })).not.toBeInTheDocument();
    // getByRole throws on multiple matches, so this also guards against a duplicate registration.
    const providersButton = within(nav).getByRole('button', { name: /^Providers$/i });
    fireEvent.click(providersButton);

    expect(window.location.hash).toBe('#settings/providers');
    expect(await screen.findByTestId('providers-settings')).toBeInTheDocument();
    expect(await screen.findByTestId('provider-card-openai')).toBeInTheDocument();
  });

  test('renders model selection when the category is selected', async () => {
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: /Model Catalog/i }));

    const pane = await screen.findByTestId('settings-category-models');
    expect(within(pane).getByTestId('model-selection-page-mock')).toBeInTheDocument();
    expect(window.location.hash).toBe('#settings/models');
  });

  test('renders Assistant Memory as its own category right after Model Catalog', async () => {
    renderPage();

    const nav = screen.getByRole('navigation', { name: /settings categories/i });
    const titles = within(nav)
      .getAllByRole('button')
      .map((button) => button.textContent);
    expect(titles.indexOf('Assistant Memory')).toBe(titles.indexOf('Model Catalog') + 1);

    fireEvent.click(within(nav).getByRole('button', { name: /^Assistant Memory$/i }));

    const pane = await screen.findByTestId('settings-category-assistant-memory');
    expect(within(pane).getByTestId('assistant-memory-settings-section')).toBeInTheDocument();
    expect(window.location.hash).toBe('#settings/assistant-memory');
  });
});
