import { MemoryStorageAdapter } from '@brainstrike/storage';
import { act, render, screen } from '@testing-library/react';

import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RootLayoutContent } from '../root-layout-content';
import type { NavigationItem } from '../types';

// Mock dependencies
vi.mock('@brainstrike/file-explorer-hooks', () => ({
  useAdapters: () => ({
    storageAdapter: new MemoryStorageAdapter(),
    fileSystemAdapter: null, // Or a mock adapter if needed
  }),
  useFileExplorer: () => ({}),
}));

// Create a stable object to hold the mock function.
const mockHandlers = {
  onNavigationClick: (_path: string) => {},
};

vi.mock('../app-layout', () => ({
  AppLayout: ({
    children,
    onNavigationClick,
  }: {
    children: React.ReactNode;
    onNavigationClick: (path: string) => void;
  }) => {
    // The mock can now safely assign to a property of the stable object.
    mockHandlers.onNavigationClick = onNavigationClick;
    return <div>{children}</div>;
  },
}));

vi.mock('@brainstrike/file-explorer-hooks', () => ({
  useAdapters: () => ({ storageAdapter: {} }),
}));

vi.mock('@brainstrike/file-explorer-ui', async (importOriginal) => {
  const original = await importOriginal<typeof import('@brainstrike/file-explorer-ui')>();
  return {
    ...original,
    FileExplorerLeftPanel: () => <div data-testid="file-explorer-left-panel" />,
    TabbedFileEditorPanel: ({ className }: { className?: string }) => (
      <div data-testid="tabbed-file-editor-panel" className={className} />
    ),
  };
});

vi.mock('@brainstrike/ui', async (importOriginal) => {
  const original = await importOriginal<typeof import('@brainstrike/ui')>();
  return {
    ...original,
    IdeLayout: ({
      children,
      leftPanelContent,
      consoleContent,
    }: {
      children: React.ReactNode;
      leftPanelContent: React.ReactNode;
      consoleContent?: React.ReactNode;
    }) => (
      <div data-testid="ide-layout">
        {leftPanelContent}
        {children}
        {consoleContent && <div data-testid="ide-console-content">{consoleContent}</div>}
      </div>
    ),
  };
});

describe('RootLayoutContent', () => {
  beforeEach(() => {
    // Reset the mock function before each test
    mockHandlers.onNavigationClick = vi.fn();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  const mockNavigationItems: NavigationItem[] = [
    { name: 'Explorer', path: '/', icon: () => <div /> },
    { name: 'Settings', path: '/settings', icon: () => <div /> },
  ];

  const MockHomePage = () => <div data-testid="home-page">Home</div>;
  const MockSettingsPage = () => <div data-testid="settings-page">Settings</div>;

  const renderComponent = () =>
    render(
      <RootLayoutContent
        navigationItems={mockNavigationItems}
        homePageContent={<MockHomePage />}
        settingsPageContent={<MockSettingsPage />}
      />
    );

  it('should render explorer view inside IdeLayout by default', () => {
    renderComponent();
    expect(screen.getByTestId('ide-layout')).toBeVisible();
    expect(screen.getByTestId('home-page')).toBeVisible();
    expect(screen.getByTestId('settings-page')).not.toBeVisible();
  });

  it('should switch to settings view and hide IdeLayout on navigation', () => {
    renderComponent();

    // Simulate navigation click by invoking the captured function
    act(() => {
      mockHandlers.onNavigationClick('/settings');
    });

    expect(screen.queryByTestId('ide-layout')).not.toBeVisible();
    expect(screen.queryByTestId('home-page')).not.toBeVisible();
    expect(screen.getByTestId('settings-page')).toBeVisible();
  });

  it('should switch back to explorer view on subsequent navigation', () => {
    renderComponent();

    // To settings
    act(() => {
      mockHandlers.onNavigationClick('/settings');
    });
    expect(screen.getByTestId('settings-page')).toBeVisible();

    // Back to explorer
    act(() => {
      mockHandlers.onNavigationClick('/');
    });
    expect(screen.getByTestId('ide-layout')).toBeVisible();
    expect(screen.getByTestId('home-page')).toBeVisible();
    expect(screen.queryByTestId('settings-page')).not.toBeVisible();
  });

  it('should render the tabbed file editor panel in console content', () => {
    renderComponent();

    expect(screen.getByTestId('ide-console-content')).toBeInTheDocument();
    expect(screen.getByTestId('tabbed-file-editor-panel')).toBeInTheDocument();
    expect(screen.getByTestId('tabbed-file-editor-panel')).toHaveClass('h-full');
  });

  it('should provide correct sidebar content to IDE layout', () => {
    renderComponent();

    expect(screen.getByTestId('file-explorer-left-panel')).toBeInTheDocument();
  });
});
