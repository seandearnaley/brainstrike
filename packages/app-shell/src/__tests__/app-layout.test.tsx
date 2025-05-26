import { render, screen } from '@testing-library/react';
import { Folder } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { AppLayout } from '../app-layout';
import type { AppShellConfig } from '../types';

vi.mock('@brainstrike/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/ui')>();
  return {
    ...actual,
    ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    ThemeToggle: () => <div data-testid="theme-toggle" />,
  };
});

const config: AppShellConfig = {
  title: 'Test',
  description: 'desc',
  themeStorageKey: 'theme',
  navigationItems: [{ name: 'Home', icon: Folder, path: '/' }],
};

const sidebar = <div data-testid="sidebar-content">Sidebar</div>;

describe('AppLayout', () => {
  it('renders navigation items, sidebar content and children', () => {
    render(
      <AppLayout config={config} currentPath="/" sidebarContent={sidebar}>
        <p>Child</p>
      </AppLayout>
    );

    expect(screen.getByTitle('Home')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-content')).toBeInTheDocument();
    expect(screen.getByText('Child')).toBeInTheDocument();
  });
});
