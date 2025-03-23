import { useTheme } from '@/providers/theme-provider';
import { fireEvent, render, screen } from '@testing-library/react';
import { ThemeToggle } from '../theme-toggle';

jest.mock('@/providers/theme-provider', () => ({
  useTheme: jest.fn(),
}));

describe('ThemeToggle', () => {
  const mockSetTheme = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders toggle button with correct title for light mode', () => {
    (useTheme as jest.Mock).mockReturnValue({
      theme: 'light',
      setTheme: mockSetTheme,
    });

    render(<ThemeToggle />);
    expect(screen.getByTitle('Switch to dark mode')).toBeInTheDocument();
  });

  it('renders toggle button with correct title for dark mode', () => {
    (useTheme as jest.Mock).mockReturnValue({
      theme: 'dark',
      setTheme: mockSetTheme,
    });

    render(<ThemeToggle />);
    expect(screen.getByTitle('Switch to light mode')).toBeInTheDocument();
  });

  it('toggles theme when clicked', () => {
    (useTheme as jest.Mock).mockReturnValue({
      theme: 'light',
      setTheme: mockSetTheme,
    });

    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole('button'));
    expect(mockSetTheme).toHaveBeenCalledWith('dark');
  });

  it('renders sun and moon icons', () => {
    (useTheme as jest.Mock).mockReturnValue({
      theme: 'light',
      setTheme: mockSetTheme,
    });

    render(<ThemeToggle />);

    expect(screen.getByTestId('theme-sun-icon')).toBeInTheDocument();
    expect(screen.getByTestId('theme-moon-icon')).toBeInTheDocument();
  });

  it('includes screen reader text', () => {
    (useTheme as jest.Mock).mockReturnValue({
      theme: 'light',
      setTheme: mockSetTheme,
    });

    render(<ThemeToggle />);
    expect(screen.getByText('Toggle theme')).toBeInTheDocument();
  });
});
