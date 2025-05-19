import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import RouterProvider from '../router-provider';

// Mock react-router-dom
vi.mock('react-router-dom', () => ({
  BrowserRouter: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="browser-router-mock">{children}</div>
  ),
}));

describe('RouterProvider', () => {
  test('renders BrowserRouter with children', () => {
    const testChild = <div data-testid="test-child">Test Child</div>;

    render(<RouterProvider>{testChild}</RouterProvider>);

    // Check if BrowserRouter is rendered
    const router = screen.getByTestId('browser-router-mock');
    expect(router).toBeInTheDocument();

    // Check if children are passed correctly
    const child = screen.getByTestId('test-child');
    expect(child).toBeInTheDocument();
    expect(child).toHaveTextContent('Test Child');
    expect(router).toContainElement(child);
  });

  test('renders custom router component with children', () => {
    const CustomRouter = ({ children }: { children?: React.ReactNode }) => (
      <div data-testid="custom-router">{children}</div>
    );

    const testChild = <div data-testid="test-child">Test Child</div>;

    render(<RouterProvider routerComponent={CustomRouter}>{testChild}</RouterProvider>);

    const customRouter = screen.getByTestId('custom-router');
    expect(customRouter).toBeInTheDocument();

    const child = screen.getByTestId('test-child');
    expect(child).toBeInTheDocument();
    expect(child).toHaveTextContent('Test Child');
    expect(customRouter).toContainElement(child);
  });
});
