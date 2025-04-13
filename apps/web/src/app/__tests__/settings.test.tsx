import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Settings from '../settings/page';

// Mock the ThemeSettings component
vi.mock('../../components/custom/settings/theme-settings', () => ({
  ThemeSettings: () => <div data-testid="theme-settings">Theme Settings Mock</div>,
}));

describe('SettingsPage', () => {
  it('renders the settings page title', () => {
    render(<Settings />);
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });

  it('renders the appearance section', () => {
    render(<Settings />);
    expect(screen.getByText('Appearance')).toBeInTheDocument();
  });

  it('renders the ThemeSettings component', () => {
    render(<Settings />);
    expect(screen.getByTestId('theme-settings')).toBeInTheDocument();
  });

  it('renders the more settings section', () => {
    render(<Settings />);
    expect(screen.getByText('More Settings')).toBeInTheDocument();
    expect(
      screen.getByText('Additional settings will be added here in future updates.')
    ).toBeInTheDocument();
  });

  it('applies correct layout classes', () => {
    const { container } = render(<Settings />);
    const mainContainer = container.firstChild as HTMLElement;
    expect(mainContainer).toHaveClass('container', 'max-w-2xl', 'mx-auto', 'py-8');
  });
});
