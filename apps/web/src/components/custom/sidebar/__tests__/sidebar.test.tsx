import { ThemeProvider } from '@brainstrike/ui';
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

describe('Sidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseLocation.mockReturnValue({ pathname: '/' });
  });

  const renderWithProviders = (ui: ReactElement) => {
    return render(ui, {
      wrapper: ({ children }) => (
        <MemoryRouter>
          <ThemeProvider defaultTheme="light" storageKey="vitest-theme">
            {children}
          </ThemeProvider>
        </MemoryRouter>
      ),
    });
  };

  it('renders all app icons with correct links', () => {
    renderWithProviders(<Sidebar />);

    // Verify all links are present
    expect(screen.getByTitle('Context Explorer')).toBeInTheDocument();
    expect(screen.getByTitle('Settings')).toBeInTheDocument();

    // Verify correct hrefs
    expect(screen.getByTitle('Context Explorer').closest('a')).toHaveAttribute('href', '/');
    expect(screen.getByTitle('Settings').closest('a')).toHaveAttribute('href', '/settings');
  });

  it('highlights the active route', () => {
    mockUseLocation.mockReturnValue({ pathname: '/settings' });
    renderWithProviders(<Sidebar />);

    const activeLink = screen.getByTitle('Settings').closest('a');
    expect(activeLink).toHaveClass('bg-gray-200 dark:bg-gray-700');

    const inactiveLink = screen.getByTitle('Context Explorer').closest('a');
    expect(inactiveLink).not.toHaveClass('bg-gray-200 dark:bg-gray-700');
  });

  it('displays icons with correct dimensions', () => {
    renderWithProviders(<Sidebar />);

    // Query for navigation icons (excluding theme toggle)
    const navLinks = screen.getAllByRole('link');
    const navIcons = navLinks.map((link) => link.querySelector('svg'));

    expect(navIcons).toHaveLength(2);
    for (const icon of navIcons) {
      expect(icon).toHaveClass('w-6 h-6');
    }
  });

  it('renders with correct layout classes', () => {
    renderWithProviders(<Sidebar />);

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
    renderWithProviders(<Sidebar />);
    // Expect the actual button rendered by ThemeToggle
    // The button likely has a title, let's check for that
    expect(screen.getByRole('button', { name: /toggle theme/i })).toBeInTheDocument();
    // Or check for the specific SVG icons if needed
    // expect(screen.getByTestId('theme-sun-icon')).toBeInTheDocument();
  });
});
