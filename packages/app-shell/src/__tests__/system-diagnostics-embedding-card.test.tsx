import type { EmbeddingTelemetrySnapshot } from '@brainstrike/embeddings';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SystemDiagnosticsPanel } from '../diagnostics/system-diagnostics-panel';

vi.mock('@brainstrike/vector-management', () => ({
  QueueDiagnosticsPanel: () => <div>Queue Diagnostics Mock</div>,
}));

vi.mock('@brainstrike/file-explorer-ui/indexing', () => ({
  useOptionalTokenCacheContext: () => null,
}));

function installDesktopDiagnostics(embedding: EmbeddingTelemetrySnapshot): void {
  (window as Window & { desktopDiagnostics?: unknown }).desktopDiagnostics = {
    getSnapshot: vi.fn(async () => ({
      ok: true,
      value: {
        collectedAt: '2026-08-01T00:00:00.000Z',
        embeddingHost: {
          active: false,
          lastError: null,
          pendingRequestCount: 0,
          runtimeId: 'embedding-host:idle',
          runtimeKind: 'embedding-host',
          sourceState: 'running',
          state: 'idle',
        },
        indexing: { activeBackfills: [] },
        reset: { userDataPath: '/tmp/brainstrike-user-data' },
        telemetry: { backgroundRuntimeMetrics: [], embedding },
      },
    })),
  };
  (window as Window & { embeddingHost?: unknown }).embeddingHost = {
    onStatus: vi.fn(() => () => undefined),
  };
}

describe('SystemDiagnosticsPanel embedding card', () => {
  afterEach(() => {
    (window as Window & { desktopDiagnostics?: unknown }).desktopDiagnostics = undefined;
    (window as Window & { embeddingHost?: unknown }).embeddingHost = undefined;
  });

  it('surfaces aggregate telemetry without rendering private identifiers', async () => {
    installDesktopDiagnostics({
      batchTransfer: {
        batchCount: 2,
        lastBytes: 12 * 1024,
        peakBytes: 16 * 1024,
        totalBytes: 28 * 1024,
      },
      cache: {
        entries: [
          {
            cacheKey: 'private-model-a|webgpu|fp16',
            createdAt: 0,
            device: 'webgpu',
            dtype: 'fp16',
            lastUsedAt: 60_000,
            memory: {
              gpuBytes: 300 * 1024 * 1024,
              heapBytes: 0,
              reason: 'model-size-estimate',
            },
            model: 'private-model-a',
            residencyMs: 60_000,
            sourceId: 'worker-a',
          },
          {
            cacheKey: 'private-model-a|webgpu|fp16',
            createdAt: 0,
            device: 'webgpu',
            dtype: 'fp16',
            lastUsedAt: 60_000,
            memory: {
              gpuBytes: 300 * 1024 * 1024,
              heapBytes: 0,
              reason: 'model-size-estimate',
            },
            model: 'private-model-a-copy',
            residencyMs: 60_000,
            sourceId: 'private-worker-b',
          },
        ],
        estimatedGpuBytes: 600 * 1024 * 1024,
        estimatedHeapBytes: 0,
        memoryEstimateUnavailableCount: 0,
        residentCount: 2,
      },
      health: {
        failureCount: 1,
        lastFailure: 'Workerpool result arrived without a pipeline-cache source diagnostic.',
      },
      lastUpdatedAt: 1000,
      peakVectorsInFlight: 4,
    });

    const { container } = render(<SystemDiagnosticsPanel />);

    expect(await screen.findByText('Embedding Runtime')).toBeInTheDocument();
    expect(screen.getByText('2 resident')).toBeInTheDocument();
    expect(screen.getByText('28 KiB')).toBeInTheDocument();
    expect(screen.getByText('600 MiB')).toBeInTheDocument();
    expect(screen.getByText('2 WebGPU · 0 WASM')).toBeInTheDocument();
    expect(screen.getByText('4 vectors')).toBeInTheDocument();
    expect(screen.getByText('Telemetry degraded')).toBeInTheDocument();
    expect(screen.getByText('1 telemetry failure')).toBeInTheDocument();
    expect(container.innerHTML).not.toMatch(
      /private-model|private-worker|Workerpool result arrived without/
    );
  });

  it('presents a loaded empty telemetry window as neutral', async () => {
    installDesktopDiagnostics({
      batchTransfer: { batchCount: 0, lastBytes: 0, peakBytes: 0, totalBytes: 0 },
      cache: {
        entries: [],
        estimatedGpuBytes: 0,
        estimatedHeapBytes: 0,
        memoryEstimateUnavailableCount: 0,
        residentCount: 0,
      },
      health: { failureCount: 0, lastFailure: null },
      lastUpdatedAt: null,
      peakVectorsInFlight: 0,
    });

    render(<SystemDiagnosticsPanel />);

    await screen.findByText('Desktop Platform');
    const card = screen.getByText('Embedding Runtime').closest('[data-slot="card"]');
    expect(card?.querySelector('[data-status]')).toHaveAttribute('data-status', 'neutral');
    expect(card).toHaveTextContent('No samples');
  });
});
