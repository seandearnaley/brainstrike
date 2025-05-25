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
});
