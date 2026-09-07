import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { InputHTMLAttributes } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAppearanceSettingsCategory,
  createFactoryResetSettingsCategory,
  createSearchIndexingSettingsCategory,
} from '../settings-category-factories';
import { type SettingsCategory, SettingsPageContent } from '../settings-page-content';

vi.mock('@brainstrike/ui', () => {
  const Input = (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} />;
  const ThemeSettings = () => <div data-testid="theme-settings" />;
  const cn = (...values: string[]) => values.filter(Boolean).join(' ');
  const useToast = vi.fn(() => ({ toast: vi.fn() }));
  return { cn, Input, ThemeSettings, useToast };
});

vi.mock('../settings/system/factory-reset-settings-section', () => ({
  FactoryResetSettingsSection: () => (
    <div data-testid="factory-reset-settings-section">Factory Reset Settings</div>
  ),
}));

vi.mock('../settings/system/search-indexing-settings-section', () => ({
  SearchIndexingSettingsSection: () => (
    <div data-testid="search-indexing-settings-section">Search Indexing Settings</div>
  ),
}));

describe('SettingsPageContent', () => {
  beforeEach(() => {
    window.location.hash = '';
  });

  const makeCategory = (id: string, title: string, description?: string): SettingsCategory => {
    const category: SettingsCategory = {
      content: <div data-testid={`category-${id}`}>{title}</div>,
      id,
      keywords: [title.toLowerCase()],
      title,
    };
    if (description !== undefined) {
      category.description = description;
    }
    return category;
  };

  it('defaults to the appearance category and updates the url hash', () => {
    render(
      <SettingsPageContent
        categories={[
          createAppearanceSettingsCategory(),
          makeCategory('advanced', 'Advanced', 'Advanced tuning'),
        ]}
      />
    );

    // The page owns its own title (BST-1668): Settings is a shell route, not
    // a dialog whose DialogTitle supplied the heading.
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByTestId('theme-settings')).toBeInTheDocument();

    const nav = screen.getByRole('navigation', { name: /settings categories/i });
    const searchbox = within(nav).getByRole('searchbox', { name: /search settings/i });
    expect(searchbox).toHaveClass('pl-10');
    // Every length asserted below is authored INLINE in rem — see
    // SETTINGS_SEARCH_INPUT_STYLE (settings-search-layout.ts),
    // SETTINGS_SEARCH_ICON_LEFT_INSET (settings-search-icon.tsx) and the
    // `style={{ paddingBlock: '2rem' }}` on the section in
    // settings-page-content.tsx. Read `.style` so the assertion stays in the
    // authored unit. `toHaveStyle` goes through getComputedStyle, which jsdom
    // >=30 resolves to px against a 16px root — a DOM-shim detail these have no
    // reason to depend on, and one that already forced a rewrite once.
    expect(searchbox.style.paddingLeft).toBe('2.5rem');
    expect(
      searchbox.parentElement?.querySelector<HTMLElement>('[data-slot="settings-search-icon"]')
        ?.style.left
    ).toBe('0.75rem');
    const appearanceButton = within(nav).getByRole('button', { name: /Appearance/i });
    expect(appearanceButton).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('settings-category-appearance')).toBeInTheDocument();
    expect(
      screen.getByTestId('settings-category-appearance').closest<HTMLElement>('section')?.style
        .paddingBlock
    ).toBe('2rem');
    expect(screen.getByRole('heading', { level: 2, name: 'Appearance' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#settings/appearance');
  });

  it('uses the default category when provided', () => {
    render(
      <SettingsPageContent
        categories={[
          createAppearanceSettingsCategory(),
          makeCategory('shortcuts', 'Keyboard Shortcuts'),
        ]}
        defaultCategoryId="shortcuts"
      />
    );

    expect(screen.getByTestId('settings-category-shortcuts')).toBeInTheDocument();
    expect(window.location.hash).toBe('#settings/shortcuts');
  });

  it('does not update browser history for a render that never commits', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ThrowDuringRender = (): never => {
      throw new Error('abort settings render');
    };

    try {
      expect(() =>
        render(
          <>
            <SettingsPageContent categories={[createAppearanceSettingsCategory()]} />
            <ThrowDuringRender />
          </>
        )
      ).toThrow('abort settings render');
      expect(window.location.hash).toBe('');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('filters navigation by search query', () => {
    render(
      <SettingsPageContent
        categories={[
          createAppearanceSettingsCategory(),
          makeCategory('network', 'Network Controls'),
          makeCategory('privacy', 'Privacy'),
        ]}
      />
    );

    const searchbox = screen.getByRole('searchbox', { name: /search settings/i });
    fireEvent.change(searchbox, { target: { value: 'privacy' } });

    expect(screen.getByRole('button', { name: /Privacy/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Network Controls/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/No settings matched/i)).not.toBeInTheDocument();

    fireEvent.change(searchbox, { target: { value: 'missing' } });
    expect(screen.getByText('No settings matched "missing".')).toBeInTheDocument();
  });

  it('reacts to manual hash updates', async () => {
    render(
      <SettingsPageContent
        categories={[
          createAppearanceSettingsCategory(),
          makeCategory('notifications', 'Notifications'),
        ]}
      />
    );

    act(() => {
      window.location.hash = '#settings/notifications';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });

    const notificationsButton = await screen.findByRole('button', { name: /Notifications/i });
    expect(notificationsButton).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('settings-category-notifications')).toBeInTheDocument();
  });

  it('shows empty state when categories are missing', () => {
    render(<SettingsPageContent categories={[]} />);
    expect(screen.getByText('No settings matched "".')).toBeInTheDocument();
    expect(screen.getByText(/Try adjusting your search/i)).toBeInTheDocument();
  });
});

describe('createFactoryResetSettingsCategory', () => {
  it('returns a SettingsCategory object with correct id', () => {
    const category = createFactoryResetSettingsCategory();
    expect(category.id).toBe('factory-reset');
  });

  it('returns a category with correct title', () => {
    const category = createFactoryResetSettingsCategory();
    expect(category.title).toBe('Factory Reset');
  });

  it('returns a category with correct description', () => {
    const category = createFactoryResetSettingsCategory();
    expect(category.description).toBe('Wipe application data and reset preferences.');
  });

  it('returns a category with correct keywords', () => {
    const category = createFactoryResetSettingsCategory();
    expect(category.keywords).toEqual([
      'factory',
      'reset',
      'resetting',
      'wipe',
      'preferences',
      'stored folders',
    ]);
  });

  it('returns a category with an icon', () => {
    const category = createFactoryResetSettingsCategory();
    expect(category.icon).toBeDefined();
  });

  it('returns a category with content', () => {
    const category = createFactoryResetSettingsCategory();
    expect(category.content).toBeTruthy();
  });

  it('content returns FactoryResetSettingsSection component', () => {
    const category = createFactoryResetSettingsCategory();
    const { container } = render(category.content as React.ReactElement);
    expect(container.querySelector('[data-testid="factory-reset-settings-section"]')).toBeTruthy();
  });

  it('integrates with SettingsPageContent', () => {
    render(
      <SettingsPageContent
        categories={[createAppearanceSettingsCategory(), createFactoryResetSettingsCategory()]}
      />
    );

    const nav = screen.getByRole('navigation', { name: /settings categories/i });
    const factoryResetButton = within(nav).getByRole('button', { name: /Factory Reset/i });
    expect(factoryResetButton).toBeInTheDocument();
  });

  it('shows factory reset category when clicked', () => {
    render(
      <SettingsPageContent
        categories={[createAppearanceSettingsCategory(), createFactoryResetSettingsCategory()]}
      />
    );

    const nav = screen.getByRole('navigation', { name: /settings categories/i });
    const factoryResetButton = within(nav).getByRole('button', { name: /Factory Reset/i });
    fireEvent.click(factoryResetButton);

    expect(factoryResetButton).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('settings-category-factory-reset')).toBeInTheDocument();
    expect(window.location.hash).toBe('#settings/factory-reset');
  });

  it('is discoverable via search keywords', () => {
    render(
      <SettingsPageContent
        categories={[createAppearanceSettingsCategory(), createFactoryResetSettingsCategory()]}
      />
    );

    const searchbox = screen.getByRole('searchbox', { name: /search settings/i });

    // Test each keyword
    const keywords = ['factory', 'reset', 'wipe', 'preferences'];
    for (const keyword of keywords) {
      fireEvent.change(searchbox, { target: { value: keyword } });
      expect(screen.getByRole('button', { name: /Factory Reset/i })).toBeInTheDocument();
    }
  });
});

describe('createSearchIndexingSettingsCategory', () => {
  it('returns the managed search/indexing category metadata and content', () => {
    const category = createSearchIndexingSettingsCategory();

    expect(category.id).toBe('search-indexing');
    expect(category.title).toBe('Search & Indexing');
    expect(category.description).toMatch(/managed cache collection/i);
    expect(category.keywords).toEqual([
      'search',
      'indexing',
      'background',
      'cache',
      'collection',
      'embeddings',
    ]);

    const { container } = render(category.content as React.ReactElement);
    expect(
      container.querySelector('[data-testid="search-indexing-settings-section"]')
    ).toBeTruthy();
  });
});
