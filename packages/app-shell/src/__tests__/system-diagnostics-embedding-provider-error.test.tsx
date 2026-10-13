import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SystemDiagnosticsPanel } from '../diagnostics/system-diagnostics-panel';

vi.mock('@brainstrike/vector-management', () => ({
  QueueDiagnosticsPanel: () => <div>Queue Diagnostics Mock</div>,
}));

vi.mock('@brainstrike/file-explorer-ui/indexing', () => ({
  useOptionalTokenCacheContext: () => null,
}));

describe('SystemDiagnosticsPanel embedding provider errors', () => {
  afterEach(() => {
    (window as Window & { desktopDiagnostics?: unknown }).desktopDiagnostics = undefined;
    (window as Window & { embeddingHost?: unknown }).embeddingHost = undefined;
  });

  it('shows a typed diagnostic refusal and its remedy after transport', async () => {
    Object.assign(window, {
      desktopDiagnostics: {
        getSnapshot: async () => ({
          error: {
            category: 'availability',
            code: 'diagnostics.unavailable',
            kind: 'refusal',
            message: 'Diagnostics are unavailable.',
            remedy: 'Refresh after reconnecting.',
          },
          ok: false,
        }),
      },
    });
    Object.assign(window, { embeddingHost: { onStatus: () => () => undefined } });
    render(<SystemDiagnosticsPanel />);
    expect(
      await screen.findByText('Diagnostics are unavailable. Refresh after reconnecting.')
    ).toBeVisible();
  });

  it('surfaces desktop embedding telemetry provider failures', async () => {
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
          errors: {
            embeddingTelemetry:
              'Embedding provider failed for private-model at /Users/private/workspace',
          },
          llmHost: {
            active: false,
            lastError: null,
            pendingRequestCount: 0,
            runtimeId: 'llm-host:idle',
            runtimeKind: 'llm-host',
            sourceState: 'running',
            state: 'idle',
          },
          reset: { userDataPath: '/tmp/brainstrike-user-data' },
          telemetry: {
            backgroundRuntimeMetrics: [],
            embedding: {
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
            },
          },
        },
      })),
    };
    (window as Window & { embeddingHost?: unknown }).embeddingHost = {
      onStatus: vi.fn(() => () => undefined),
    };

    const { container } = render(<SystemDiagnosticsPanel />);

    expect(await screen.findByText('Embedding telemetry unavailable')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Embedding telemetry provider failed. See internal diagnostics for details.'
    );
    expect(container.innerHTML).not.toMatch(/private-model|Users\/private|workspace/);
  });
});
