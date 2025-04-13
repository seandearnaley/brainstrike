import type FS from '@isomorphic-git/lightning-fs';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, vi } from 'vitest';
import { FSProvider, useFS } from '../fs-provider';

// Mock LightningFS
vi.mock('@isomorphic-git/lightning-fs', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      promises: {
        mkdir: vi.fn().mockResolvedValue(undefined),
        rmdir: vi.fn().mockResolvedValue(undefined),
      },
    })),
  };
});

// Mock console methods to avoid noise in test output
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

// Define the FSContextType to match the one in fs-provider.tsx
interface FSContextType {
  fs: FS | null;
  isInitialized: boolean;
  error: Error | null;
}

describe('FSProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('provides default context values through useFS hook', () => {
    // Create a wrapper to test the hook directly
    const TestHookWrapper = () => {
      const { fs, isInitialized, error } = useFS();

      // Verify the default values
      expect(fs).toBeNull();
      expect(isInitialized).toBe(false);
      expect(error).toBeNull();

      return null;
    };

    // Render without Provider to test default context
    render(<TestHookWrapper />);
  });

  test('initializes fs and updates context', () => {
    let contextValues: FSContextType = {
      fs: null,
      isInitialized: false,
      error: null,
    };

    // Component to capture context values
    const TestComponent = () => {
      contextValues = useFS();
      return <div data-testid="test-component">Test Component</div>;
    };

    render(
      <FSProvider>
        <TestComponent />
      </FSProvider>
    );

    // Initially not initialized
    expect(contextValues.isInitialized).toBe(false);

    // Advance timers to trigger initialization
    act(() => {
      vi.advanceTimersByTime(200);
    });

    // After timer, should be initialized
    expect(contextValues.fs).not.toBeNull();
    expect(contextValues.isInitialized).toBe(true);
    expect(contextValues.error).toBeNull();
  });
});
