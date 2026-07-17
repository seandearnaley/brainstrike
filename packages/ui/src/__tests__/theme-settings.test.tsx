import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTheme } from '../theme-provider';
import { ThemeSettings } from '../theme-settings';

// Use relative path for vi.mock
vi.mock('../theme-provider', () => ({
  useTheme: vi.fn(),
}));

describe('ThemeSettings', () => {
  const mockSetTheme = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    (useTheme as ReturnType<typeof vi.fn>).mockReturnValue({
      setTheme: mockSetTheme,
      theme: 'light',
    });
  });

  it('renders all theme options', () => {
    render(<ThemeSettings />);

    expect(screen.getByText('Light')).toBeInTheDocument();
    expect(screen.getByText('Dark')).toBeInTheDocument();
    expect(screen.getByText('System')).toBeInTheDocument();
  });

  it('highlights the active theme button', () => {
    (useTheme as ReturnType<typeof vi.fn>).mockReturnValue({
      setTheme: mockSetTheme,
      theme: 'dark',
    });

    render(<ThemeSettings />);

    // Get all buttons
    const darkButton = screen.getByRole('button', { name: /dark/i });
    const lightButton = screen.getByRole('button', { name: /light/i });
    const systemButton = screen.getByRole('button', { name: /system/i });

    // The active button (dark) should not have the outline class
    expect(darkButton).not.toHaveClass('border');
    // The inactive buttons should have the outline class (border)
    expect(lightButton).toHaveClass('border');
    expect(systemButton).toHaveClass('border');
  });

  it('calls setTheme when a theme button is clicked', () => {
    render(<ThemeSettings />);

    fireEvent.click(screen.getByText('Dark'));
    expect(mockSetTheme).toHaveBeenCalledWith('dark');

    fireEvent.click(screen.getByText('Light'));
    expect(mockSetTheme).toHaveBeenCalledWith('light');

    fireEvent.click(screen.getByText('System'));
    expect(mockSetTheme).toHaveBeenCalledWith('system');
  });

  it('renders theme description text', () => {
    render(<ThemeSettings />);

    expect(
      screen.getByText(
        'Select your preferred theme mode. System will automatically match your device settings.'
      )
    ).toBeInTheDocument();
  });

  it('renders theme icons', () => {
    render(<ThemeSettings />);

    // Check for the presence of each specific icon
    expect(screen.getByTestId('light-theme-icon')).toBeInTheDocument();
    expect(screen.getByTestId('dark-theme-icon')).toBeInTheDocument();
    expect(screen.getByTestId('system-theme-icon')).toBeInTheDocument();
  });
});
