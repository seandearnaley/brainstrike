import { ThemeSettings } from '@brainstrike/ui';
import { render, screen } from '@testing-library/react';
import { HelmetProvider } from 'react-helmet-async';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import SettingsPageContent from '../page-content';

// Mock the ThemeSettings component
vi.mock('@brainstrike/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/ui')>();
  return {
    ...actual,
    ThemeSettings: vi.fn(() => <div data-testid="theme-settings-mock">Theme Settings Mock</div>),
  };
});

// Stub App Shell HUD components that depend on DbProvider
vi.mock('@brainstrike/app-shell', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/app-shell')>();
  return {
    ...actual,
    VectorStatusWithDb: () => <div data-testid="vector-status-mock" />,
    QueueHud: () => <div data-testid="queue-hud-mock" />,
  };
});

// Mock DB hooks to avoid requiring DbProvider in this shallow page test
vi.mock('@brainstrike/db', async () => {
  return {
    usePGliteDatabase: () => null,
    useVectorEnabled: () => false,
  };
});

describe('SettingsPageContent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('renders settings page with correct structure', () => {
    render(
      <HelmetProvider>
        <SettingsPageContent />
      </HelmetProvider>
    );

    // Check for main heading
    expect(screen.getByRole('heading', { name: 'Settings', level: 1 })).toBeInTheDocument();

    // Check for appearance section heading
    expect(screen.getByRole('heading', { name: 'Appearance', level: 2 })).toBeInTheDocument();

    // Check for more settings section heading
    expect(screen.getByRole('heading', { name: 'More Settings', level: 2 })).toBeInTheDocument();

    // Check for future updates text
    expect(
      screen.getByText(/Additional settings will be added here in future updates/i)
    ).toBeInTheDocument();
  });

  test('renders ThemeSettings component', () => {
    render(
      <HelmetProvider>
        <SettingsPageContent />
      </HelmetProvider>
    );

    // Verify ThemeSettings is rendered
    expect(ThemeSettings).toHaveBeenCalled();
    expect(screen.getByTestId('theme-settings-mock')).toBeInTheDocument();
  });

  test('has correct container styling', () => {
    render(
      <HelmetProvider>
        <SettingsPageContent />
      </HelmetProvider>
    );

    // Find the main container
    const container = screen.getByText('Settings').closest('div');
    expect(container).toHaveClass('container');
    expect(container).toHaveClass('max-w-2xl');
    expect(container).toHaveClass('mx-auto');
    expect(container).toHaveClass('py-8');

    // Check for proper spacing between sections
    const sectionsContainer = screen.getByText('Appearance').closest('div');
    const parentElement = sectionsContainer?.parentElement;
    expect(parentElement).not.toBeNull();
    expect(parentElement).toHaveClass('space-y-6');
  });
});
