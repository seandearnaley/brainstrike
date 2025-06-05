import { MemoryStorageAdapter } from '@brainstrike/storage';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RootLayoutContent } from '../root-layout-content';
import type { AppShellConfig, NavigationItem } from '../types';

// Mock dependencies
vi.mock('@brainstrike/file-explorer-hooks', () => ({
  useAdapters: () => ({
    storageAdapter: new MemoryStorageAdapter(),
    fileSystemAdapter: null, // Or a mock adapter if needed
  }),
}));

interface MockAppLayoutProps {
  children: ReactNode;
  onNavigationClick: (path: string) => void;
  currentPath: string;
  sidebarContent?: ReactNode;
  config: AppShellConfig;
}

vi.mock('../app-layout', () => ({
  AppLayout: ({
    children,
    onNavigationClick,
    currentPath,
    sidebarContent,
    config,
  }: MockAppLayoutProps) => (
    <div>
      <button type="button" onClick={() => onNavigationClick('/')}>
        Home
      </button>
      <button type="button" onClick={() => onNavigationClick('/settings')}>
        Settings
      </button>
      <button type="button" onClick={() => onNavigationClick('/unknown')}>
        Unknown
      </button>
      <div>Current Path: {currentPath}</div>
      {config.navigationItems.map((item: NavigationItem) => (
        <div key={item.path}>{item.name}</div>
      ))}
      {sidebarContent && <div data-testid="sidebar-content">{sidebarContent}</div>}
      {children}
    </div>
  ),
}));

const mockNavigationItems: NavigationItem[] = [
  { name: 'Explorer', path: '/', icon: () => <span>Explorer Icon</span> },
  { name: 'Settings Tab', path: '/settings', icon: () => <span>Settings Icon</span> },
];

const MockHomePage = () => <div data-testid="home-page">Home Page Content</div>;
const MockSettingsPage = () => <div data-testid="settings-page">Settings Page Content</div>;
const MockSidebar = () => <div data-testid="sidebar-mock">Sidebar Mock Content</div>;

describe('RootLayoutContent', () => {
  beforeEach(() => {
    // Reset DOM or any other state if necessary
    document.body.innerHTML = '';
  });

  it('should render home page content by default', () => {
    render(
      <RootLayoutContent
        navigationItems={mockNavigationItems}
        homePageContent={<MockHomePage />}
        settingsPageContent={<MockSettingsPage />}
        sidebarContent={<MockSidebar />}
      />
    );
    expect(screen.getByTestId('home-page')).toBeVisible();
    expect(screen.queryByTestId('settings-page')).not.toBeVisible();
    expect(screen.getByTestId('sidebar-content')).toBeVisible();
    expect(screen.getByText('Current Path: /')).toBeInTheDocument();
  });

  it('should switch to settings page content when settings navigation is clicked', () => {
    render(
      <RootLayoutContent
        navigationItems={mockNavigationItems}
        homePageContent={<MockHomePage />}
        settingsPageContent={<MockSettingsPage />}
        sidebarContent={<MockSidebar />}
      />
    );

    fireEvent.click(screen.getByText('Settings'));

    expect(screen.queryByTestId('home-page')).not.toBeVisible();
    expect(screen.getByTestId('settings-page')).toBeVisible();
    expect(screen.queryByTestId('sidebar-content')).not.toBeInTheDocument();
    expect(screen.getByText('Current Path: /settings')).toBeInTheDocument();
  });

  it('should switch back to home page content when home navigation is clicked', () => {
    render(
      <RootLayoutContent
        navigationItems={mockNavigationItems}
        homePageContent={<MockHomePage />}
        settingsPageContent={<MockSettingsPage />}
        sidebarContent={<MockSidebar />}
      />
    );

    // Go to settings first
    fireEvent.click(screen.getByText('Settings'));
    // Then back to home
    fireEvent.click(screen.getByText('Home'));

    expect(screen.getByTestId('home-page')).toBeVisible();
    expect(screen.queryByTestId('settings-page')).not.toBeVisible();
    expect(screen.getByTestId('sidebar-content')).toBeVisible();
    expect(screen.getByText('Current Path: /')).toBeInTheDocument();
  });

  it('should not change tab for an unknown navigation path', () => {
    render(
      <RootLayoutContent
        navigationItems={mockNavigationItems}
        homePageContent={<MockHomePage />}
        settingsPageContent={<MockSettingsPage />}
        sidebarContent={<MockSidebar />}
      />
    );
    expect(screen.getByTestId('home-page')).toBeVisible();
    expect(screen.getByText('Current Path: /')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Unknown'));

    expect(screen.getByTestId('home-page')).toBeVisible();
    expect(screen.queryByTestId('settings-page')).not.toBeVisible();
    expect(screen.getByText('Current Path: /')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-content')).toBeVisible();
  });

  it('should not show sidebar content when on settings page', () => {
    render(
      <RootLayoutContent
        navigationItems={mockNavigationItems}
        homePageContent={<MockHomePage />}
        settingsPageContent={<MockSettingsPage />}
        sidebarContent={<MockSidebar />}
      />
    );
    fireEvent.click(screen.getByText('Settings'));
    expect(screen.queryByTestId('sidebar-content')).not.toBeInTheDocument();
  });

  it('should show sidebar content when on explorer page', () => {
    render(
      <RootLayoutContent
        navigationItems={mockNavigationItems}
        homePageContent={<MockHomePage />}
        settingsPageContent={<MockSettingsPage />}
        sidebarContent={<MockSidebar />}
      />
    );
    // Default is explorer page
    expect(screen.getByTestId('sidebar-content')).toBeVisible();
    // Navigate to settings and back
    fireEvent.click(screen.getByText('Settings'));
    fireEvent.click(screen.getByText('Home'));
    expect(screen.getByTestId('sidebar-content')).toBeVisible();
  });

  it('should pass correct navigationItems to AppLayout', () => {
    render(
      <RootLayoutContent
        navigationItems={mockNavigationItems}
        homePageContent={<MockHomePage />}
        settingsPageContent={<MockSettingsPage />}
      />
    );
    expect(screen.getByText('Explorer')).toBeInTheDocument();
    expect(screen.getByText('Settings Tab')).toBeInTheDocument();
  });

  it('should handle undefined sidebarContent gracefully', () => {
    render(
      <RootLayoutContent
        navigationItems={mockNavigationItems}
        homePageContent={<MockHomePage />}
        settingsPageContent={<MockSettingsPage />}
        sidebarContent={undefined}
      />
    );
    expect(screen.getByTestId('home-page')).toBeVisible();
    expect(screen.queryByTestId('sidebar-content')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Settings'));
    expect(screen.getByTestId('settings-page')).toBeVisible();
    expect(screen.queryByTestId('sidebar-content')).not.toBeInTheDocument();
  });
});
