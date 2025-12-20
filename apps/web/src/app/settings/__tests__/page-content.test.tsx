import { ThemeSettings } from '@brainstrike/ui';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { HelmetProvider } from 'react-helmet-async';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import SettingsPageContent from '../page-content';

vi.mock('@brainstrike/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/ui')>();
  return {
    ...actual,
    ThemeSettings: vi.fn(() => <div data-testid="theme-settings-mock">Theme Settings Mock</div>),
  };
});

vi.mock('@brainstrike/preferences', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/preferences')>();
  return {
    ...actual,
    ModelSelectionPage: vi.fn(() => <div data-testid="model-selection-page-mock" />),
  };
});

describe('Web SettingsPageContent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = '';
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

    expect(ThemeSettings).toHaveBeenCalled();
    expect(screen.getByTestId('theme-settings-mock')).toBeInTheDocument();
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
