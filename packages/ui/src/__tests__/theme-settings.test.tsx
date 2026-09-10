import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTheme } from '../theme-provider';
import { ThemeSettings } from '../theme-settings';
import { THEMES } from '../themes';

vi.mock('../theme-provider', () => ({
  useTheme: vi.fn(),
}));

describe('ThemeSettings', () => {
  const setMode = vi.fn();
  const setTheme = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    (useTheme as ReturnType<typeof vi.fn>).mockReturnValue({
      mode: 'light',
      setMode,
      setTheme,
      theme: 'brainstrike',
    });
  });

  it('renders the mode buttons and highlights the active one', () => {
    render(<ThemeSettings />);
    expect(screen.getByRole('button', { name: 'Light' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'System' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('calls setMode with the clicked mode', () => {
    render(<ThemeSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));
    expect(setMode).toHaveBeenCalledWith('dark');
  });

  it('renders one theme card per registry entry inside a radiogroup', () => {
    render(<ThemeSettings />);
    const group = screen.getByRole('radiogroup', { name: 'Theme' });
    const cards = screen.getAllByRole('radio');
    expect(cards).toHaveLength(THEMES.length);
    for (const theme of THEMES) {
      expect(group).toContainElement(screen.getByRole('radio', { name: theme.label }));
    }
  });

  it('marks the active theme card checked and switches on click', () => {
    render(<ThemeSettings />);
    expect(screen.getByRole('radio', { name: 'Brainstrike' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(screen.getByRole('radio', { name: 'Tide' })).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(screen.getByRole('radio', { name: 'Tide' }));
    expect(setTheme).toHaveBeenCalledWith('tide');
  });

  it('paints each card swatch from the registry', () => {
    render(<ThemeSettings />);
    const ember = THEMES.find((t) => t.id === 'ember');
    const swatch = screen.getByTestId('theme-swatch-ember-light-primary');
    expect(swatch).toHaveStyle({ backgroundColor: ember?.swatch.light.primary });
  });

  it('renders the mode icons', () => {
    render(<ThemeSettings />);
    expect(screen.getByTestId('light-theme-icon')).toBeInTheDocument();
    expect(screen.getByTestId('dark-theme-icon')).toBeInTheDocument();
    expect(screen.getByTestId('system-theme-icon')).toBeInTheDocument();
  });
});
