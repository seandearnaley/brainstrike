import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIndexerTelemetryAggregator } from './telemetry';
import { useIndexerTelemetry } from './use-indexer-telemetry';

vi.mock('./telemetry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./telemetry')>();
  return {
    ...actual,
    createIndexerTelemetryAggregator: vi.fn((windowMs?: number, maxEvents?: number) => {
      const aggregator = actual.createIndexerTelemetryAggregator(windowMs, maxEvents);
      return {
        ...aggregator,
        dispose: vi.fn(aggregator.dispose),
      };
    }),
  };
});

function StrictModeWrapper({ children }: { readonly children: ReactNode }): ReactNode {
  return <StrictMode>{children}</StrictMode>;
}

describe('useIndexerTelemetry', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('disposes every aggregator created under StrictMode', () => {
    const { unmount } = renderHook(() => useIndexerTelemetry(), {
      wrapper: StrictModeWrapper,
    });
    const createAggregator = vi.mocked(createIndexerTelemetryAggregator);
    expect(createAggregator).toHaveBeenCalled();

    unmount();

    for (const result of createAggregator.mock.results) {
      if (result.type !== 'return') {
        throw new Error('Expected each telemetry aggregator creation to return.');
      }
      expect(result.value.dispose).toHaveBeenCalledTimes(1);
    }
  });
});
