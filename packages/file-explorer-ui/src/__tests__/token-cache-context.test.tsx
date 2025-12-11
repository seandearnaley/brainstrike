import { render, renderHook, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenCacheProvider, useTokenCacheContext } from '../token-cache-context';

vi.mock('@brainstrike/preferences', () => ({
  tokenPreferencesSelectors: {
    accurateCounting: (state: { accurateCounting?: boolean }) => state.accurateCounting ?? false,
  },
  useTokenPreferencesStore: (selector: (state: { accurateCounting?: boolean }) => boolean) =>
    selector({ accurateCounting: false }),
}));

vi.mock('@brainstrike/token-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/token-cache')>();

  class MockFileHasher {
    init = vi.fn().mockResolvedValue(undefined);
    hashContent = vi.fn(async (content: string) => `hash-${content}`);
  }

  return {
    ...actual,
    createTokenCacheWorkerPool: vi.fn(() => ({
      exec: vi.fn(async () => ({ tokenCount: 0, contentHash: 'stub' })),
      terminate: vi.fn().mockResolvedValue(undefined),
    })),
    FileHasher: MockFileHasher,
  };
});

const dbStub = {
  query: vi.fn(async () => ({ rows: [], affectedRows: 0 })),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('TokenCacheProvider', () => {
  it('renders children immediately even when the database is not ready', async () => {
    render(
      <TokenCacheProvider db={null}>
        <div data-testid="child">child</div>
      </TokenCacheProvider>
    );

    expect(await screen.findByTestId('child')).toBeInTheDocument();
  });

  it('exposes readiness once worker and store initialization complete', async () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <TokenCacheProvider db={dbStub}>{children}</TokenCacheProvider>
    );

    const { result } = renderHook(() => useTokenCacheContext(), { wrapper });

    expect(result.current.isReady).toBe(false);

    await waitFor(() => {
      expect(result.current.isReady).toBe(true);
    });
  });

  it('keeps children mounted when the database becomes available later', async () => {
    let mountCount = 0;

    const StatefulChild = () => {
      const [mountIndex, setMountIndex] = React.useState(0);

      React.useEffect(() => {
        mountCount += 1;
        setMountIndex(mountCount);
      }, []);

      return <div data-testid="mount-index">{mountIndex}</div>;
    };

    const { rerender } = render(
      <TokenCacheProvider db={null}>
        <StatefulChild />
      </TokenCacheProvider>
    );

    await waitFor(() => expect(screen.getByTestId('mount-index')).toHaveTextContent('1'));

    rerender(
      <TokenCacheProvider db={dbStub}>
        <StatefulChild />
      </TokenCacheProvider>
    );

    await waitFor(() => expect(screen.getByTestId('mount-index')).toHaveTextContent('1'));
  });
});
