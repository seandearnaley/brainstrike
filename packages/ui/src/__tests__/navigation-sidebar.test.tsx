import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Folder, Settings } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { type NavigationItem, NavigationSidebar } from '../navigation-sidebar';
import { TooltipProvider } from '../tooltip';

const items: NavigationItem[] = [
  { icon: Folder, name: 'Context Explorer', path: '/' },
  { icon: Settings, name: 'Settings', path: '/settings' },
];

const renderSidebar = (
  currentPath = '/',
  props: Partial<React.ComponentProps<typeof NavigationSidebar>> = {}
) =>
  render(
    <TooltipProvider>
      <NavigationSidebar currentPath={currentPath} items={items} {...props} />
    </TooltipProvider>
  );

describe('NavigationSidebar', () => {
  it('renders navigation items with correct links', () => {
    renderSidebar();

    const explorerLink = screen.getByRole('link', { name: 'Context Explorer' });
    const settingsLink = screen.getByRole('link', { name: 'Settings' });

    expect(explorerLink).toHaveAttribute('href', '/');
    expect(settingsLink).toHaveAttribute('href', '/settings');
  });

  it('highlights the active route with proper styling', () => {
    renderSidebar('/settings');

    const activeLink = screen.getByRole('link', { name: 'Settings' });
    expect(activeLink).toHaveClass('bg-accent', 'text-accent-foreground');

    const inactiveLink = screen.getByRole('link', { name: 'Context Explorer' });
    expect(inactiveLink).not.toHaveClass('bg-accent', 'text-accent-foreground');
  });

  it('sets aria-current="page" on active navigation item', () => {
    renderSidebar('/settings');

    const activeLink = screen.getByRole('link', { name: 'Settings' });
    expect(activeLink).toHaveAttribute('aria-current', 'page');

    const inactiveLink = screen.getByRole('link', { name: 'Context Explorer' });
    expect(inactiveLink).not.toHaveAttribute('aria-current');
  });

  it('renders icons with correct dimensions', () => {
    renderSidebar();

    const icons = screen.getAllByRole('link').map((link) => link.querySelector('svg'));
    expect(icons).toHaveLength(2);
    for (const icon of icons) {
      expect(icon).toHaveClass('w-5', 'h-5');
    }
  });

  it('renders icons with aria-hidden for accessibility', () => {
    renderSidebar();

    const icons = screen.getAllByRole('link').map((link) => link.querySelector('svg'));
    for (const icon of icons) {
      expect(icon).toHaveAttribute('aria-hidden', 'true');
    }
  });

  // NOTE: `toHaveClass` only asserts the class STRING is on the element. jsdom
  // never runs Tailwind, so this passes whether or not `bg-sidebar` and
  // `border-sidebar-border` actually emit any CSS — they produced nothing at all
  // until BST-1611 registered `--color-sidebar*` in both apps' `@theme` blocks.
  // The check that these utilities resolve to real paint lives at the source
  // level in `scripts/__tests__/sidebar-theme-contract.test.mjs`; do not read a
  // green here as evidence that the sidebar is styled.
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
      'gap-2',
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
    renderSidebar('/', { onItemClick: handleClick });

    const button = screen.getByRole('button', { name: 'Context Explorer' });
    expect(button).toHaveAttribute('aria-label', 'Context Explorer');
  });

  it('sets aria-current on active button when onItemClick is provided', () => {
    const handleClick = vi.fn();
    renderSidebar('/settings', { onItemClick: handleClick });

    const activeButton = screen.getByRole('button', { name: 'Settings' });
    expect(activeButton).toHaveAttribute('aria-current', 'page');

    const inactiveButton = screen.getByRole('button', { name: 'Context Explorer' });
    expect(inactiveButton).not.toHaveAttribute('aria-current');
  });

  it('calls onItemClick with correct path when button is clicked', async () => {
    const user = userEvent.setup();
    const handleClick = vi.fn();
    renderSidebar('/', { onItemClick: handleClick });

    const settingsButton = screen.getByRole('button', { name: 'Settings' });
    await user.click(settingsButton);

    expect(handleClick).toHaveBeenCalledWith('/settings');
  });

  it('sets default aria-label on navigation element', () => {
    renderSidebar();

    const sidebar = screen.getByRole('navigation');
    expect(sidebar).toHaveAttribute('aria-label', 'Main navigation');
  });

  it('renders children in footer area', () => {
    render(
      <TooltipProvider>
        <NavigationSidebar currentPath="/" items={items}>
          <button type="button">Theme Toggle</button>
        </NavigationSidebar>
      </TooltipProvider>
    );

    const themeButton = screen.getByRole('button', { name: 'Theme Toggle' });
    expect(themeButton).toBeInTheDocument();
  });

  it('shows tooltip on hover', async () => {
    const user = userEvent.setup();
    renderSidebar();

    const explorerLink = screen.getByRole('link', { name: 'Context Explorer' });
    await user.hover(explorerLink);

    // Tooltip content should appear (after delay configured in TooltipProvider)
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('Context Explorer');
  });
});
