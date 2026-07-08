import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTheme } from '../theme-provider';
import { ThemeToggle } from '../theme-toggle';
import { TooltipProvider } from '../tooltip';

vi.mock('../theme-provider', () => ({
  useTheme: vi.fn(),
}));

const renderThemeToggle = () =>
  render(
    <TooltipProvider delayDuration={0}>
      <ThemeToggle />
    </TooltipProvider>
  );

describe('ThemeToggle', () => {
  const mockSetTheme = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders toggle button with correct aria-label for light mode', () => {
    (useTheme as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      setTheme: mockSetTheme,
      theme: 'light',
    });

    renderThemeToggle();
    expect(screen.getByRole('button', { name: 'Switch to dark mode' })).toBeInTheDocument();
  });

  it('renders toggle button with correct aria-label for dark mode', () => {
    (useTheme as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      setTheme: mockSetTheme,
      theme: 'dark',
    });

    renderThemeToggle();
    expect(screen.getByRole('button', { name: 'Switch to light mode' })).toBeInTheDocument();
  });

  it('toggles theme when clicked', async () => {
    const user = userEvent.setup();
    (useTheme as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      setTheme: mockSetTheme,
      theme: 'light',
    });

    renderThemeToggle();
    await user.click(screen.getByRole('button'));
    expect(mockSetTheme).toHaveBeenCalledWith('dark');
  });

  it('renders sun and moon icons with aria-hidden', () => {
    (useTheme as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      setTheme: mockSetTheme,
      theme: 'light',
    });

    renderThemeToggle();

    const sunIcon = screen.getByTestId('theme-sun-icon');
    const moonIcon = screen.getByTestId('theme-moon-icon');

    expect(sunIcon).toBeInTheDocument();
    expect(moonIcon).toBeInTheDocument();
    expect(sunIcon).toHaveAttribute('aria-hidden', 'true');
    expect(moonIcon).toHaveAttribute('aria-hidden', 'true');
  });

  it('includes screen reader text', () => {
    (useTheme as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      setTheme: mockSetTheme,
      theme: 'light',
    });

    renderThemeToggle();
    expect(screen.getByText('Toggle theme')).toBeInTheDocument();
  });

  it('shows tooltip on hover', async () => {
    const user = userEvent.setup();
    (useTheme as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      setTheme: mockSetTheme,
      theme: 'light',
    });

    renderThemeToggle();

    const button = screen.getByRole('button');
    await user.hover(button);

    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('Switch to dark mode');
  });

  it('has correct styling for tactile feedback', () => {
    (useTheme as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      setTheme: mockSetTheme,
      theme: 'light',
    });

    renderThemeToggle();

    const button = screen.getByRole('button');
    expect(button).toHaveClass('h-12', 'w-12', 'rounded-lg');
  });
});
