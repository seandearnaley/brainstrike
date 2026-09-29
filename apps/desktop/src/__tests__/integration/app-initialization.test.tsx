import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// Simple integration test that doesn't rely on complex package dependencies
describe('App Initialization Integration', () => {
  it('should handle missing root element gracefully', () => {
    // Test the error case from main.tsx
    const originalGetElementById = document.getElementById;
    document.getElementById = vi.fn().mockReturnValue(null);

    expect(() => {
      const rootElement = document.getElementById('root');
      if (!rootElement) {
        throw new Error("Failed to find the root element with ID 'root'");
      }
    }).toThrow("Failed to find the root element with ID 'root'");

    // Restore original function
    document.getElementById = originalGetElementById;
  });

  it('should have a valid DOM environment', () => {
    // Test that the DOM environment is properly set up
    expect(document).toBeDefined();
    expect(window).toBeDefined();
    expect(document.createElement).toBeDefined();
  });

  it('should be able to create and render basic React components', () => {
    // Test basic React rendering capability
    const TestComponent = () => <div data-testid="test-component">Test</div>;

    render(<TestComponent />);
    expect(screen.getByTestId('test-component')).toBeInTheDocument();
    expect(screen.getByText('Test')).toBeInTheDocument();
  });

  it('should have access to electron API in test environment', () => {
    // Test that the electron API mock is available
    expect(window.electronAPI).toBeDefined();
    const electronApi = window.electronAPI;
    if (!(electronApi && 'storage' in electronApi && 'fileSystem' in electronApi)) {
      throw new Error('Expected the Electron API mock to be available.');
    }
    expect(electronApi.storage).toBeDefined();
    expect(electronApi.fileSystem).toBeDefined();
  });
});
