import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import RootLayoutContent from '../../../renderer/components/root-layout-content';

// Mock the app-shell component
vi.mock('@brainstrike/app-shell', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="app-shell">{children}</div>
  ),
  AppLayout: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="app-layout">{children}</div>
  ),
  createAppConfig: vi.fn(() => ({
    navigationItems: [],
    theme: 'light',
  })),
}));

// Mock the page components to avoid adapter dependencies
vi.mock('../../../renderer/components/home-page-content', () => ({
  default: () => <div data-testid="home-page-content">Home Page Content</div>,
}));

vi.mock('../../../renderer/components/settings/page-content', () => ({
  default: () => <div data-testid="settings-page-content">Settings Page Content</div>,
}));

describe('RootLayoutContent', () => {
  it('should render without crashing', () => {
    render(<RootLayoutContent />);
    expect(screen.getByTestId('app-layout')).toBeInTheDocument();
  });

  it('should render AppLayout component', () => {
    render(<RootLayoutContent />);
    const appLayout = screen.getByTestId('app-layout');
    expect(appLayout).toBeInTheDocument();
  });

  it('should render home page content by default', () => {
    render(<RootLayoutContent />);
    expect(screen.getByTestId('home-page-content')).toBeInTheDocument();
    expect(screen.getByText('Home Page Content')).toBeInTheDocument();
  });
});
