import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Sidebar from '../sidebar';

// Mock react-router-dom
const mockUseLocation = vi.fn().mockReturnValue({ pathname: '/' });
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useLocation: () => mockUseLocation(),
  };
});

// Mock theme provider and ThemeToggle component to avoid theme provider dependency
vi.mock('@/providers/theme-provider', () => ({
  useTheme: () => ({
    theme: 'light',
    setTheme: vi.fn(),
  }),
}));

// Mock the ThemeToggle component to avoid theme provider issues
vi.mock('@/components/custom/theme-toggle', () => ({
  ThemeToggle: () => <div data-testid="theme-toggle">Theme Toggle</div>,
}));

describe('Sidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseLocation.mockReturnValue({ pathname: '/' });
  });

  const renderWithRouter = (ui: ReactElement) => {
    return render(ui, { wrapper: MemoryRouter });
  };

  it('renders all app icons with correct links', () => {
    renderWithRouter(<Sidebar />);

    // Verify all links are present
    expect(screen.getByTitle('Context Explorer')).toBeInTheDocument();
    expect(screen.getByTitle('Settings')).toBeInTheDocument();

    // Verify correct hrefs
    expect(screen.getByTitle('Context Explorer').closest('a')).toHaveAttribute('href', '/');
    expect(screen.getByTitle('Settings').closest('a')).toHaveAttribute('href', '/settings');
  });

  it('highlights the active route', () => {
    mockUseLocation.mockReturnValue({ pathname: '/settings' });
    renderWithRouter(<Sidebar />);

    const activeLink = screen.getByTitle('Settings').closest('a');
    expect(activeLink).toHaveClass('bg-gray-200 dark:bg-gray-700');

    const inactiveLink = screen.getByTitle('Context Explorer').closest('a');
    expect(inactiveLink).not.toHaveClass('bg-gray-200 dark:bg-gray-700');
  });

  it('displays icons with correct dimensions', () => {
    renderWithRouter(<Sidebar />);

    // Query for navigation icons (excluding theme toggle)
    const navLinks = screen.getAllByRole('link');
    const navIcons = navLinks.map((link) => link.querySelector('svg'));

    expect(navIcons).toHaveLength(2);
    for (const icon of navIcons) {
      expect(icon).toHaveClass('w-6 h-6');
    }
  });

  it('renders with correct layout classes', () => {
    renderWithRouter(<Sidebar />);

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
    renderWithRouter(<Sidebar />);
    expect(screen.getByTestId('theme-toggle')).toBeInTheDocument();
  });
});
