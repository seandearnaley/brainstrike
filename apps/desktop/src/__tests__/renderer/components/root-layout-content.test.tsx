import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import RootLayoutContent from '../../../renderer/components/root-layout-content';

// Mock the file-explorer-hooks
vi.mock('@brainstrike/file-explorer-hooks', () => ({
  useAdapters: vi.fn(() => ({
    storageAdapter: {
      // Mock storage adapter
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
    },
  })),
}));

// Mock the file-explorer-ui
vi.mock('@brainstrike/file-explorer-ui', () => ({
  FileExplorerProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="file-explorer-provider">{children}</div>
  ),
  UnifiedFileExplorerProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="unified-file-explorer-provider">{children}</div>
  ),
}));

// Mock UI provider to avoid asynchronous provider effects in unit tests
vi.mock('@brainstrike/ui', async (importOriginal) => {
  const original = await importOriginal<typeof import('@brainstrike/ui')>();
  return {
    ...original,
    PanelLayoutProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    ElectronPanelPersistenceAdapter: vi.fn(() => ({})),
  };
});

// Mock the app-shell component (do not import original to avoid transitive deps)
vi.mock('@brainstrike/app-shell', () => ({
  navigationItems: [],
  AppShell: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="app-shell">{children}</div>
  ),
  AppLayout: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="app-layout">
      <main>{children}</main>
    </div>
  ),
  createAppConfig: vi.fn(() => ({
    title: 'BrainStrike.ai',
    description: 'Multi-app dashboard',
    themeStorageKey: 'app-theme',
    navigationItems: [],
  })),
  RootLayoutContent: ({
    sidebarContent,
    homePageContent,
  }: {
    sidebarContent?: React.ReactNode;
    homePageContent: React.ReactNode;
  }) => (
    <div data-testid="file-explorer-provider">
      <div data-testid="app-layout">
        {sidebarContent && <aside>{sidebarContent}</aside>}
        <main>{homePageContent}</main>
      </div>
    </div>
  ),
}));

// Mock the page components to avoid adapter dependencies
vi.mock('../../../renderer/components/home-page-content', () => ({
  default: () => <div data-testid="home-page-content">Home Page Content</div>,
  DesktopFileExplorerLeftPanel: () => (
    <div data-testid="desktop-file-explorer-left-panel">Left Panel</div>
  ),
}));

vi.mock('../../../renderer/components/settings/page-content', () => ({
  default: () => <div data-testid="settings-page-content">Settings Page Content</div>,
}));

describe('RootLayoutContent', () => {
  it('should render without crashing', () => {
    render(<RootLayoutContent />);
    expect(screen.getByTestId('file-explorer-provider')).toBeInTheDocument();
  });

  it('should render AppLayout component', () => {
    render(<RootLayoutContent />);
    expect(screen.getByTestId('app-layout')).toBeInTheDocument();
  });

  it('should render home page content by default', () => {
    render(<RootLayoutContent />);
    expect(screen.getByTestId('home-page-content')).toBeInTheDocument();
  });
});
