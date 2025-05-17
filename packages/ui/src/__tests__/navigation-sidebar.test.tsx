import { render, screen } from '@testing-library/react';
import { Folder, Settings } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { type NavigationItem, NavigationSidebar } from '../navigation-sidebar';

const items: NavigationItem[] = [
  { name: 'Context Explorer', icon: Folder, path: '/' },
  { name: 'Settings', icon: Settings, path: '/settings' },
];

const renderSidebar = (currentPath = '/') =>
  render(<NavigationSidebar items={items} currentPath={currentPath} />);

describe('NavigationSidebar', () => {
  it('renders navigation items with correct links', () => {
    renderSidebar();

    expect(screen.getByTitle('Context Explorer').closest('a')).toHaveAttribute('href', '/');
    expect(screen.getByTitle('Settings').closest('a')).toHaveAttribute('href', '/settings');
  });

  it('highlights the active route', () => {
    renderSidebar('/settings');

    const activeLink = screen.getByTitle('Settings').closest('a');
    expect(activeLink).toHaveClass('bg-gray-200 dark:bg-gray-700');

    const inactiveLink = screen.getByTitle('Context Explorer').closest('a');
    expect(inactiveLink).not.toHaveClass('bg-gray-200 dark:bg-gray-700');
  });

  it('renders icons with correct dimensions', () => {
    renderSidebar();

    const icons = screen.getAllByRole('link').map((link) => link.querySelector('svg'));
    expect(icons).toHaveLength(2);
    for (const icon of icons) {
      expect(icon).toHaveClass('w-6 h-6');
    }
  });

  it('renders with correct layout classes', () => {
    renderSidebar();

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
});
