import { render, screen } from '@testing-library/react';
import { Folder, Settings } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { type NavigationItem, NavigationSidebar } from '../navigation-sidebar';

const items: NavigationItem[] = [
  { name: 'Context Explorer', icon: Folder, path: '/' },
  { name: 'Settings', icon: Settings, path: '/settings' },
];

const renderSidebar = (currentPath = '/') =>
  render(<NavigationSidebar currentPath={currentPath} items={items} />);

describe('NavigationSidebar', () => {
  it('renders navigation items with correct links', () => {
    renderSidebar();

    expect(screen.getByTitle('Context Explorer').closest('a')).toHaveAttribute('href', '/');
    expect(screen.getByTitle('Settings').closest('a')).toHaveAttribute('href', '/settings');
  });

  it('highlights the active route', () => {
    renderSidebar('/settings');

    const activeLink = screen.getByTitle('Settings').closest('a');
    expect(activeLink).toHaveClass('bg-sidebar-accent', 'text-sidebar-primary');

    const inactiveLink = screen.getByTitle('Context Explorer').closest('a');
    expect(inactiveLink).not.toHaveClass('bg-sidebar-accent', 'text-sidebar-primary');
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

    const sidebar = screen.getByRole('navigation');
    expect(sidebar).toHaveClass(
      'w-16',
      'bg-sidebar',
      'h-full',
      'flex',
      'flex-col',
      'items-center',
      'py-4',
      'space-y-4',
      'border-r',
      'border-sidebar-border'
    );
  });

  it('applies aria-label to links', () => {
    renderSidebar();

    const link = screen.getByRole('link', { name: 'Context Explorer' });
    expect(link).toHaveAttribute('aria-label', 'Context Explorer');
  });

  it('applies aria-label to buttons when onItemClick is provided', () => {
    const handleClick = vi.fn();
    render(<NavigationSidebar currentPath="/" items={items} onItemClick={handleClick} />);

    const button = screen.getByRole('button', { name: 'Context Explorer' });
    expect(button).toHaveAttribute('aria-label', 'Context Explorer');
  });

  it('sets default aria-label on aside element', () => {
    renderSidebar();

    const sidebar = screen.getByRole('navigation');
    expect(sidebar).toHaveAttribute('aria-label', 'Main navigation');
  });
});
