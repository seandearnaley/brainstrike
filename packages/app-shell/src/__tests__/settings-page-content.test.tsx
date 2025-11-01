import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { InputHTMLAttributes } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

beforeAll(() => {
  const elementPrototype = Element.prototype as unknown as {
    hasPointerCapture?: (pointerId: number) => boolean;
    scrollIntoView?: () => void;
  };
  elementPrototype.hasPointerCapture = () => false;
  elementPrototype.scrollIntoView = () => {};
  if (typeof window.matchMedia !== 'function') {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: () => ({
        matches: false,
        media: '',
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    });
  }
});

describe('SettingsPageContent', () => {
  beforeEach(() => {
    window.location.hash = '';
  });

  const makeCategory = (id: string, title: string, description?: string): SettingsCategory => {
    const category: SettingsCategory = {
      id,
      title,
      keywords: [title.toLowerCase()],
      render: () => <div data-testid={`category-${id}`}>{title}</div>,
    };
    if (description !== undefined) {
      category.description = description;
    }
    return category;
  };

  it('renders category navigation with appearance selected by default', () => {
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

  it('filters categories using the in-page search', () => {
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

  it('updates the hash and detail pane when selecting a new category', () => {
    render(
      <SettingsPageContent
        categories={[
          createAppearanceSettingsCategory(),
          makeCategory('shortcuts', 'Keyboard Shortcuts'),
        ]}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Keyboard Shortcuts/i }));

    expect(window.location.hash).toBe('#settings/shortcuts');
    expect(screen.getByTestId('settings-category-shortcuts')).toBeInTheDocument();
  });

  it('responds to hash changes triggered outside the component', async () => {
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
});
