import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { InputHTMLAttributes } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAppearanceSettingsCategory,
  type SettingsCategory,
  SettingsPageContent,
} from '../settings-page-content';

vi.mock('@brainstrike/ui', () => {
  const Input = (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} />;
  const ThemeSettings = () => <div data-testid="theme-settings" />;
  const cn = (...values: string[]) => values.filter(Boolean).join(' ');
  return { Input, ThemeSettings, cn };
});

describe('SettingsPageContent', () => {
  beforeEach(() => {
    window.location.hash = '';
  });

  const makeCategory = (id: string, title: string, description?: string): SettingsCategory => ({
    id,
    title,
    description,
    keywords: [title.toLowerCase()],
    render: () => <div data-testid={`category-${id}`}>{title}</div>,
  });

  it('defaults to the appearance category and updates the url hash', () => {
    render(
      <SettingsPageContent
        categories={[
          createAppearanceSettingsCategory(),
          makeCategory('advanced', 'Advanced', 'Advanced tuning'),
        ]}
      />
    );

    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByTestId('theme-settings')).toBeInTheDocument();

    const nav = screen.getByRole('navigation', { name: /settings categories/i });
    const appearanceButton = within(nav).getByRole('button', { name: /Appearance/i });
    expect(appearanceButton).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('settings-category-appearance')).toBeInTheDocument();
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
