import { useTheme } from '@/providers/theme-provider';
import { render, screen } from '@testing-library/react';
import { usePathname } from 'next/navigation';
import Sidebar from '../sidebar';

// Mock next/navigation
jest.mock('next/navigation', () => ({
  usePathname: jest.fn(),
}));

// Mock theme provider
jest.mock('@/providers/theme-provider', () => ({
  useTheme: jest.fn().mockReturnValue({
    theme: 'light',
    setTheme: jest.fn(),
  }),
}));

describe('Sidebar', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (usePathname as jest.Mock).mockReturnValue('/');
  });

  it('renders all app icons with correct links', () => {
    render(<Sidebar />);

    // Verify all links are present
    expect(screen.getByTitle('Context Explorer')).toBeInTheDocument();
    expect(screen.getByTitle('App 2')).toBeInTheDocument();
    expect(screen.getByTitle('Settings')).toBeInTheDocument();

    // Verify correct hrefs
    expect(screen.getByTitle('Context Explorer').closest('a')).toHaveAttribute('href', '/');
    expect(screen.getByTitle('App 2').closest('a')).toHaveAttribute('href', '/app2');
    expect(screen.getByTitle('Settings').closest('a')).toHaveAttribute('href', '/settings');
  });

  it('highlights the active route', () => {
    (usePathname as jest.Mock).mockReturnValue('/app2');
    render(<Sidebar />);

    const activeLink = screen.getByTitle('App 2').closest('a');
    expect(activeLink).toHaveClass('bg-gray-200 dark:bg-gray-700');

    const inactiveLink = screen.getByTitle('Context Explorer').closest('a');
    expect(inactiveLink).not.toHaveClass('bg-gray-200 dark:bg-gray-700');
  });

  it('displays icons with correct dimensions', () => {
    render(<Sidebar />);

    // Query for navigation icons (excluding theme toggle)
    const navLinks = screen.getAllByRole('link');
    const navIcons = navLinks.map((link) => link.querySelector('svg'));

    expect(navIcons).toHaveLength(3);
    for (const icon of navIcons) {
      expect(icon).toHaveClass('w-6 h-6');
    }
  });

  it('renders with correct layout classes', () => {
    render(<Sidebar />);

    const sidebar = screen.getByRole('complementary');
    expect(sidebar).toHaveClass(
      'w-16',
      'bg-gray-100',
      'dark:bg-gray-800',
      'h-full',
      'flex',
      'flex-col',
      'items-center',
      'py-4',
      'space-y-4'
    );
  });

  it('renders theme toggle button', () => {
    render(<Sidebar />);
    expect(screen.getByTitle(/Switch to (dark|light) mode/)).toBeInTheDocument();
  });
});
