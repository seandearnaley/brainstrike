import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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

describe('FSProvider', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <FSProvider>
        <div>Test Content</div>
      </FSProvider>
    );

    expect(container).toBeTruthy();
  });

  it('provides useFS hook for context access', () => {
    expect(useFS).toBeDefined();
  });
});
