import { emitIndexedFile, emitIndexingError } from '@brainstrike/token-cache';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SystemDiagnosticsPanel } from '../diagnostics/system-diagnostics-panel';

vi.mock('@brainstrike/vector-management', () => ({
  QueueDiagnosticsPanel: () => null,
}));

describe('SystemDiagnosticsPanel token indexer telemetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    window.dispatchEvent(new Event('focus'));
    (window as Window & { embeddingHost?: unknown }).embeddingHost = {
      onStatus: vi.fn(() => () => undefined),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    (window as Window & { embeddingHost?: unknown }).embeddingHost = undefined;
  });

  it('renders aggregate performance without exposing event identity', async () => {
    const { container } = render(<SystemDiagnosticsPanel />);

    act(() => {
      emitIndexedFile({
        compositeKey: 'secret-key-1',
        elapsedMs: 10,
        filePath: '/private/secret-one.ts',
        fileSize: 1024,
        folderId: 'private-folder',
        mode: 'accurate',
        skipped: false,
        tokenCount: 100,
      });
      emitIndexedFile({
        compositeKey: 'secret-key-2',
        elapsedMs: 20,
        filePath: '/private/secret-two.ts',
        fileSize: 2048,
        folderId: 'private-folder',
        mode: 'accurate',
        skipped: false,
        tokenCount: 200,
      });
      emitIndexedFile({
        compositeKey: 'secret-key-3',
        elapsedMs: 1,
        filePath: '/private/secret-three.ts',
        fileSize: 512,
        folderId: 'private-folder',
        mode: 'accurate',
        skipped: true,
        tokenCount: 0,
      });
      emitIndexingError({
        compositeKey: 'secret-key-4',
        errorMessage: 'secret indexing failure',
        filePath: '/private/secret-four.ts',
        folderId: 'private-folder',
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(screen.getByText('Token Indexing')).toBeInTheDocument();
    expect(screen.getByTestId('token-indexer-latency')).toHaveTextContent(
      'avg 15 ms · p50 20 ms · p95 20 ms'
    );
    expect(screen.getByTestId('token-indexer-cache-hit-rate')).toHaveTextContent('33%');
    expect(screen.getByTestId('token-indexer-throughput')).toHaveTextContent('3 files/min');
    expect(screen.getByTestId('token-indexer-error-count')).toHaveTextContent('1 error');
    expect(screen.getByText('300 tokens')).toBeInTheDocument();
    expect(container.innerHTML).not.toMatch(
      /secret-key|private-folder|private\/secret|secret indexing/
    );
  });

  it('distinguishes cache-hit events from an empty telemetry window', async () => {
    render(<SystemDiagnosticsPanel />);

    act(() => {
      emitIndexedFile({
        compositeKey: 'cache-hit-key',
        elapsedMs: 1,
        filePath: '/private/cache-hit.ts',
        fileSize: 1024,
        folderId: 'private-folder',
        mode: 'accurate',
        skipped: true,
        tokenCount: 0,
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(screen.getByTestId('token-indexer-latency')).toHaveTextContent('avg — · p50 — · p95 —');
    expect(screen.getByTestId('token-indexer-cache-hit-rate')).toHaveTextContent('100%');
    expect(screen.getByTestId('token-indexer-throughput')).toHaveTextContent('1 file/min');
    expect(screen.getByText('1 sample')).toBeInTheDocument();
  });
});
