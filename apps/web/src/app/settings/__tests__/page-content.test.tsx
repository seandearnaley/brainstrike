import { __resetNativeToolPreferencesStoreForTests } from '@brainstrike/preferences';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { HelmetProvider } from 'react-helmet-async';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import SettingsPageContent from '../page-content';

vi.mock('@brainstrike/preferences/settings/models/model-selection-page', () => ({
  ModelSelectionPage: vi.fn(() => <div data-testid="model-selection-page-mock" />),
}));

vi.mock('@brainstrike/preferences/settings-page-content', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@brainstrike/preferences/settings-page-content')>();
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

  const renderPage = () =>
    render(
      <HelmetProvider>
        <SettingsPageContent />
      </HelmetProvider>
    );

  test('renders navigation and defaults to appearance category', () => {
    renderPage();

    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();

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

  test('renders model selection when the category is selected', async () => {
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: /Models & Providers/i }));

    const pane = await screen.findByTestId('settings-category-models');
    expect(within(pane).getByTestId('model-selection-page-mock')).toBeInTheDocument();
    expect(window.location.hash).toBe('#settings/models');
  });
});
