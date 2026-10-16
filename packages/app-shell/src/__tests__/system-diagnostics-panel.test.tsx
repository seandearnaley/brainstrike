/**
 * Tests for SystemDiagnosticsPanel (BST-181)
 */

import {
  __resetDatabaseStatusStoreForTests,
  useDatabaseStatusStore,
} from '@brainstrike/app-state/stores/database-status-store';
import { databaseQueryTelemetry } from '@brainstrike/db';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rendererLongTaskTelemetry } from '../diagnostics/renderer-long-task-telemetry';
import { SystemDiagnosticsPanel } from '../diagnostics/system-diagnostics-panel';
import { createSystemDiagnosticsSettingsCategory } from '../diagnostics/system-diagnostics-settings-category';

// Mock QueueDiagnosticsPanel from vector-management
vi.mock('@brainstrike/vector-management', () => ({
  QueueDiagnosticsPanel: ({ showRefresh }: { showRefresh?: boolean }) => (
    <div data-show-refresh={showRefresh} data-testid="queue-diagnostics-panel">
      Queue Diagnostics Mock
    </div>
  ),
}));

// Mock the optional token cache context hook
const mockUseOptionalTokenCacheContext = vi.fn();
vi.mock('@brainstrike/file-explorer-ui/indexing', () => ({
  useOptionalTokenCacheContext: () => mockUseOptionalTokenCacheContext(),
}));

describe('SystemDiagnosticsPanel', () => {
  beforeEach(() => {
    __resetDatabaseStatusStoreForTests();
    rendererLongTaskTelemetry.reset();
    (window as Window & { desktopDiagnostics?: unknown }).desktopDiagnostics = undefined;
    (window as Window & { embeddingHost?: unknown }).embeddingHost = {
      onStatus: vi.fn(() => () => undefined),
    };
  });

  afterEach(() => {
    __resetDatabaseStatusStoreForTests();
    rendererLongTaskTelemetry.reset();
    (window as Window & { desktopDiagnostics?: unknown }).desktopDiagnostics = undefined;
    (window as Window & { embeddingHost?: unknown }).embeddingHost = undefined;
    vi.unstubAllGlobals();
  });

  describe('rendering', () => {
    it('surfaces invalid embedding telemetry from a desktop snapshot', async () => {
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
                health: { failureCount: 1, lastFailure: null },
                lastUpdatedAt: 1000,
                peakVectorsInFlight: 0,
              },
            },
          },
        })),
      };

      render(<SystemDiagnosticsPanel />);

      expect(
        await screen.findByText(
          'Desktop embedding telemetry is invalid: Embedding telemetry health requires lastFailure exactly when failureCount is non-zero.'
        )
      ).toBeInTheDocument();
      expect(screen.queryByText('1000')).not.toBeInTheDocument();
    });

    it('refreshes desktop embedding telemetry when the hidden host reports status', async () => {
      const createSnapshot = (totalBytes: number) => {
        const telemetry = {
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
        } as const;
        return {
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
          telemetry: {
            backgroundRuntimeMetrics: [],
            embedding: {
              ...telemetry,
              batchTransfer:
                totalBytes === 0
                  ? telemetry.batchTransfer
                  : {
                      batchCount: 1,
                      lastBytes: totalBytes,
                      peakBytes: totalBytes,
                      totalBytes,
                    },
              lastUpdatedAt: totalBytes === 0 ? null : 1000,
            },
          },
        };
      };
      const getSnapshot = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, value: createSnapshot(0) })
        .mockResolvedValueOnce({ ok: true, value: createSnapshot(0) })
        .mockRejectedValueOnce(
          new Error('Something went wrong. The details were recorded in the diagnostic log.')
        );
      const statusListenerRef: { current: ((status: unknown) => void) | null } = { current: null };
      const unsubscribe = vi.fn();
      (window as Window & { desktopDiagnostics?: unknown }).desktopDiagnostics = { getSnapshot };
      (window as Window & { embeddingHost?: unknown }).embeddingHost = {
        onStatus: vi.fn((listener: (status: unknown) => void) => {
          statusListenerRef.current = listener;
          return unsubscribe;
        }),
      };

      const { unmount } = render(<SystemDiagnosticsPanel />);

      await waitFor(() => expect(getSnapshot).toHaveBeenCalledTimes(1));
      expect(screen.getByText('Batch Transfer').parentElement).toHaveTextContent('0 B');
      const statusListener = statusListenerRef.current;
      if (!statusListener) {
        throw new Error('Expected the diagnostics panel to subscribe to embedding host status.');
      }
      const updatedTelemetry = createSnapshot(8 * 1024).telemetry.embedding;
      act(() => statusListener({ embeddingRuntime: { telemetry: updatedTelemetry } }));

      await waitFor(() => {
        expect(
          screen.queryByText(/Embedding host status telemetry is invalid:/)
        ).not.toBeInTheDocument();
        expect(getSnapshot).toHaveBeenCalledTimes(1);
        expect(screen.getByText('Batch Transfer').parentElement).toHaveTextContent('8 KiB');
      });

      act(() =>
        statusListener({
          active: false,
          lastError: null,
          runtimeId: 'embedding-host:restarting',
          runtimeKind: 'embedding-host',
          state: 'starting',
        })
      );
      expect(screen.getByText('Batch Transfer').parentElement).toHaveTextContent('8 KiB');

      act(() =>
        statusListener({
          active: false,
          lastError: 'Embedding host renderer crashed.',
          runtimeId: 'embedding-host:crashed',
          runtimeKind: 'embedding-host',
          state: 'error',
        })
      );
      expect(screen.getByText('Batch Transfer').parentElement).toHaveTextContent('0 B');

      await userEvent.click(screen.getByRole('button', { name: /refresh all diagnostics/i }));

      await waitFor(() => {
        expect(getSnapshot).toHaveBeenCalledTimes(2);
        expect(screen.getByText('Batch Transfer').parentElement).toHaveTextContent('0 B');
      });

      const refreshButton = screen.getByRole('button', { name: /refresh all diagnostics/i });
      await waitFor(() => expect(refreshButton).toBeEnabled());
      await userEvent.click(refreshButton);
      expect(
        await screen.findByText(
          'Something went wrong. The details were recorded in the diagnostic log.'
        )
      ).toBeInTheDocument();

      const listenerAfterFailedRefresh = statusListenerRef.current;
      if (!listenerAfterFailedRefresh) {
        throw new Error('Expected the diagnostics panel to retain its host status subscription.');
      }
      act(() => listenerAfterFailedRefresh({ embeddingRuntime: { telemetry: updatedTelemetry } }));
      expect(
        screen.getByText('Something went wrong. The details were recorded in the diagnostic log.')
      ).toBeInTheDocument();
      unmount();
      expect(unsubscribe).toHaveBeenCalledTimes(3);
    });

    it('renders header with title and description', () => {
      render(<SystemDiagnosticsPanel />);

      expect(screen.getByText('System Diagnostics')).toBeInTheDocument();
      expect(
        screen.getByText('Real-time health monitoring for database, queues, and workers')
      ).toBeInTheDocument();
    });

    it('renders refresh all button', () => {
      render(<SystemDiagnosticsPanel />);

      const refreshButton = screen.getByRole('button', { name: /refresh all diagnostics/i });
      expect(refreshButton).toBeInTheDocument();
    });

    it('renders database status section', () => {
      render(<SystemDiagnosticsPanel />);

      expect(screen.getByText('Database')).toBeInTheDocument();
      expect(screen.getByText('PGlite database connection')).toBeInTheDocument();
    });

    it('renders token cache worker section', () => {
      render(<SystemDiagnosticsPanel />);

      expect(screen.getByText('Token Cache Worker')).toBeInTheDocument();
      expect(screen.getByText('Token counting and indexing worker')).toBeInTheDocument();
    });

    it('renders coarse database query telemetry by feature area', () => {
      try {
        databaseQueryTelemetry.recordQuery({ durationMs: 12, feature: 'queue-stats' });
        databaseQueryTelemetry.recordQuery({
          durationMs: 20,
          failed: true,
          feature: 'queue-stats',
        });
        databaseQueryTelemetry.recordQuery({
          durationMs: 4,
          feature: 'token-estimation',
          hitCount: 3,
          lookupCount: 4,
        });
        databaseQueryTelemetry.recordLiveSubscriptionStarted();
        databaseQueryTelemetry.recordLiveUpdate();

        const telemetrySnapshot = databaseQueryTelemetry.getSnapshot();
        const queueMetrics = telemetrySnapshot.features['queue-stats'];
        render(<SystemDiagnosticsPanel />);

        expect(screen.getByText('Database Queries')).toBeInTheDocument();
        expect(screen.getByText('Queue stats')).toBeInTheDocument();
        expect(screen.getByText('Token estimation')).toBeInTheDocument();
        expect(screen.getByText('75% cache hit')).toBeInTheDocument();
        expect(screen.getByText('1 active')).toBeInTheDocument();
        expect(screen.getByTestId('database-live-update-metrics')).toHaveTextContent(
          `${telemetrySnapshot.liveUpdateCount} ${telemetrySnapshot.liveUpdateCount === 1 ? 'update' : 'updates'}`
        );
        expect(screen.getByTestId('database-live-update-metrics')).not.toHaveTextContent('/ min');
        expect(screen.getByTestId('database-query-queue-stats-metrics')).toHaveTextContent(
          `${queueMetrics.queryCount} queries · ${queueMetrics.failureCount} failed · p50 ${Math.round(queueMetrics.durationP50Ms)} ms · p95 ${Math.round(queueMetrics.durationP95Ms)} ms · max ${Math.round(queueMetrics.maxDurationMs)} ms · ${queueMetrics.droppedSampleCount} dropped`
        );
        expect(screen.getByTestId('database-query-queue-stats-metrics')).not.toHaveTextContent(
          '/ min'
        );
      } finally {
        databaseQueryTelemetry.recordLiveSubscriptionEnded();
      }
    });

    it('uses exact query totals for healthy overflow status', () => {
      const baseline = databaseQueryTelemetry.snapshot();
      const snapshot = {
        ...baseline,
        droppedSampleCount: 4,
        features: {
          'file-tree': {
            ...baseline.features['file-tree'],
            droppedSampleCount: 4,
            failureCount: 0,
            queriesPerMinute: 5,
            queryCount: 5,
          },
          'live-query': {
            ...baseline.features['live-query'],
            failureCount: 0,
            queriesPerMinute: 0,
            queryCount: 0,
          },
          'queue-stats': {
            ...baseline.features['queue-stats'],
            failureCount: 0,
            queriesPerMinute: 0,
            queryCount: 0,
          },
          'token-estimation': {
            ...baseline.features['token-estimation'],
            failureCount: 0,
            queriesPerMinute: 0,
            queryCount: 0,
          },
        },
        sampleCount: 1,
      };
      const getSnapshot = vi.spyOn(databaseQueryTelemetry, 'getSnapshot').mockReturnValue(snapshot);
      const subscribe = vi
        .spyOn(databaseQueryTelemetry, 'subscribe')
        .mockImplementation(() => () => undefined);

      try {
        render(<SystemDiagnosticsPanel />);

        expect(screen.getByText('5 queries')).toHaveAttribute('data-status', 'success');
        expect(screen.getByText('Retention overflow').parentElement).toHaveClass(
          'text-muted-foreground'
        );
      } finally {
        getSnapshot.mockRestore();
        subscribe.mockRestore();
      }
    });

    it('renders an explicit failed query-telemetry snapshot without throwing', () => {
      const baseline = databaseQueryTelemetry.snapshot();
      const getSnapshot = vi.spyOn(databaseQueryTelemetry, 'getSnapshot').mockReturnValue({
        ...baseline,
        availability: 'failed',
        unavailableReason: 'retention clock unavailable',
      });
      const subscribe = vi
        .spyOn(databaseQueryTelemetry, 'subscribe')
        .mockImplementation(() => () => undefined);

      try {
        render(<SystemDiagnosticsPanel />);

        expect(screen.getByRole('alert')).toHaveTextContent(
          'Query telemetry unavailable: retention clock unavailable'
        );
        expect(screen.getByText(/^\d+ queries?$/)).toHaveAttribute('data-status', 'error');
      } finally {
        getSnapshot.mockRestore();
        subscribe.mockRestore();
      }
    });

    it('updates database query telemetry while diagnostics remains open', async () => {
      vi.useFakeTimers();
      try {
        render(<SystemDiagnosticsPanel />);
        const sampleCountBefore = databaseQueryTelemetry.getSnapshot().sampleCount;

        act(() => {
          databaseQueryTelemetry.recordQuery({ durationMs: 9, feature: 'file-tree' });
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });

        const expectedCount = sampleCountBefore + 1;
        expect(
          screen.getByText(`${expectedCount} ${expectedCount === 1 ? 'query' : 'queries'}`)
        ).toBeInTheDocument();
        expect(screen.getByText('File tree')).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it('renders queue diagnostics panel', () => {
      render(<SystemDiagnosticsPanel />);

      return waitFor(() => {
        expect(screen.getByTestId('queue-diagnostics-panel')).toBeInTheDocument();
      });
    });

    it('surfaces renderer long-task aggregates in system diagnostics', () => {
      rendererLongTaskTelemetry.record({
        durationMs: 125,
        enabledFeatureFlags: ['diagnostic-search'],
        route: 'settings',
      });

      render(<SystemDiagnosticsPanel />);

      expect(screen.getByText('Renderer Long Tasks')).toBeInTheDocument();
      expect(screen.getByText('Idle · 1 sample')).toBeInTheDocument();
      expect(screen.getAllByText('125 ms')).toHaveLength(3);
      expect(screen.getByText('Delivery-time routes')).toBeInTheDocument();
      expect(screen.getByText('Delivery-time feature flags')).toBeInTheDocument();
      expect(screen.getByText('settings (1)')).toBeInTheDocument();
      expect(screen.getByText('diagnostic-search (1)')).toBeInTheDocument();
    });

    it('updates renderer long-task diagnostics when the collector publishes', () => {
      render(<SystemDiagnosticsPanel />);

      expect(screen.getByText('No feature flag source')).toBeInTheDocument();

      act(() => {
        rendererLongTaskTelemetry.record({
          durationMs: 80,
          enabledFeatureFlags: null,
          route: 'explorer',
        });
      });

      expect(screen.getByText('Idle · 1 sample')).toBeInTheDocument();
      expect(screen.getAllByText('80 ms')).toHaveLength(3);
      expect(screen.getByText('Unavailable for retained samples')).toBeInTheDocument();
    });

    it('does not treat retained samples with unknown flag context as no flags active', () => {
      rendererLongTaskTelemetry.record({
        durationMs: 80,
        enabledFeatureFlags: null,
        route: 'explorer',
      });
      rendererLongTaskTelemetry.updateContext({
        enabledFeatureFlags: ['diagnostics-v2'],
        route: 'explorer',
      });

      render(<SystemDiagnosticsPanel />);

      expect(screen.getByText('Delivery-time feature flags').parentElement).toHaveTextContent(
        'Unavailable for retained samples'
      );
      act(() => {
        rendererLongTaskTelemetry.record({
          durationMs: 90,
          enabledFeatureFlags: ['diagnostics-v2'],
          route: 'explorer',
        });
      });
      expect(screen.getByText('Delivery-time feature flags').parentElement).toHaveTextContent(
        'diagnostics-v2 (1) · partial context, 1 of 2 samples'
      );
    });

    it('shows the known-context denominator when mixed samples have no active flags', () => {
      rendererLongTaskTelemetry.record({
        durationMs: 80,
        enabledFeatureFlags: null,
        route: 'explorer',
      });
      rendererLongTaskTelemetry.record({
        durationMs: 90,
        enabledFeatureFlags: [],
        route: 'explorer',
      });

      render(<SystemDiagnosticsPanel />);

      expect(screen.getByText('Delivery-time feature flags').parentElement).toHaveTextContent(
        'Partial feature flag context, 1 of 2 samples'
      );
    });

    it('labels unsupported long-task collection instead of reporting zero samples', () => {
      vi.stubGlobal('PerformanceObserver', undefined);
      act(() => {
        rendererLongTaskTelemetry.observe(() => ({
          enabledFeatureFlags: [],
          route: 'settings',
        }));
      });

      render(<SystemDiagnosticsPanel />);

      expect(screen.getByText('Unsupported')).toBeInTheDocument();
      expect(
        screen.getByText('PerformanceObserver is unavailable in this renderer.')
      ).toBeInTheDocument();
    });

    it('keeps the retained sample count visible when observation fails', () => {
      class ThrowingPerformanceObserver {
        static readonly supportedEntryTypes = ['longtask'];

        constructor(_callback: PerformanceObserverCallback) {
          throw new Error('observer construction failed');
        }
      }
      rendererLongTaskTelemetry.record({
        durationMs: 80,
        enabledFeatureFlags: [],
        route: 'settings',
      });
      vi.stubGlobal('PerformanceObserver', ThrowingPerformanceObserver);
      act(() => {
        rendererLongTaskTelemetry.observe(() => ({
          enabledFeatureFlags: [],
          route: 'settings',
        }));
      });

      render(<SystemDiagnosticsPanel />);

      expect(screen.getByText('Failed · 1 sample')).toBeInTheDocument();
      expect(screen.getByText('observer construction failed')).toBeInTheDocument();
    });

    it('distinguishes no samples from no active feature flags', () => {
      class MockPerformanceObserver {
        static readonly supportedEntryTypes = ['longtask'];

        observe(): void {}

        disconnect(): void {}
      }
      vi.stubGlobal('PerformanceObserver', MockPerformanceObserver);
      act(() => {
        rendererLongTaskTelemetry.observe(() => ({
          enabledFeatureFlags: [],
          route: 'settings',
        }));
      });

      render(<SystemDiagnosticsPanel />);

      expect(screen.getByText('Delivery-time feature flags').parentElement).toHaveTextContent(
        'No samples'
      );
    });

    it('renders desktop platform diagnostics when the desktop bridge is available', async () => {
      (window as Window & { desktopDiagnostics?: unknown }).desktopDiagnostics = {
        getSnapshot: vi.fn(async () => ({
          ok: true,
          value: {
            collectedAt: '2026-05-20T00:00:00.000Z',
            crashRecovery: {
              lastRendererCrashAt: '2026-05-20T00:01:00.000Z',
              lastRendererCrashExitCode: 5,
              lastRendererCrashReason: 'crashed',
              lastRendererCrashWindowRole: 'visible-ui',
              lastRendererReloadAt: null,
              lastRendererReloadWindowRole: null,
              pendingRendererRecovery: true,
              rendererCrashCount: 1,
              rendererReloadAttemptCount: 0,
              suppressedRendererReloadCount: 0,
            },
            embeddingHost: {
              active: false,
              lastError: null,
              pendingRequestCount: 0,
              runtimeId: 'embedding-host:idle',
              runtimeKind: 'embedding-host',
              sourceState: 'running',
              state: 'idle',
            },
            indexing: {
              activeBackfills: [
                {
                  embeddingSetId: 'set-1',
                  progress: { current: 2, total: 4 },
                  requestId: 'background-indexing-backfill:set-1',
                  source: 'background-indexing',
                },
              ],
              databaseWork: {
                runningLabel: 'background-indexing-backfill',
                runningPriority: 'background',
              },
              dimensionIndexMaintenance: {
                maintenance: [
                  {
                    attempts: 1,
                    completedAt: null,
                    dimension: 384,
                    lastDurationMs: null,
                    lastError: null,
                    lastForegroundProbeMaxMs: null,
                    lastForegroundProbeP95Ms: null,
                    lastInvalidIndexName: null,
                    nextRunAt: '2026-05-20T00:02:00.000Z',
                    reason: 'embedding-backfill:set-1',
                    requestedAt: '2026-05-20T00:01:00.000Z',
                    startedAt: null,
                    state: 'pending',
                    strategy: 'regular',
                  },
                ],
                suspensions: [
                  {
                    dimension: 384,
                    reason: 'nonblocking-background-indexing',
                    suspendedAt: '2026-05-20T00:00:59.000Z',
                  },
                ],
              },
            },
            migration: {
              attemptCount: 2,
              inFlight: false,
              lastFailure: null,
              lastSucceededAt: '2026-05-20T00:00:30.000Z',
            },
            reset: {
              lastCompletedAt: null,
              lastDeletedPathCount: 0,
              lastError: null,
              lastFailedAt: null,
              lastPreservedPathCount: 0,
              lastStartedAt: null,
              status: 'idle',
              userDataPath: '/tmp/brainstrike-user-data',
            },
            telemetry: {
              backgroundRuntimeMetrics: [
                {
                  cpuPercent: '1.0',
                  idleWakeupsPerSecond: '0.0',
                  osProcessId: 123,
                  privateKb: '1000',
                  runtimeKind: 'embedding-host',
                  sharedKb: '200',
                  workingSetKb: '1200',
                },
              ],
            },
          },
        })),
      };

      render(<SystemDiagnosticsPanel />);

      expect(await screen.findByText('Desktop Platform')).toBeInTheDocument();
      expect(screen.getByText('Embedding Host')).toBeInTheDocument();
      expect(screen.getByText('/tmp/brainstrike-user-data')).toBeInTheDocument();
      expect(screen.getByText('Active Backfills')).toBeInTheDocument();
      expect(screen.getByText('1 active')).toBeInTheDocument();
      expect(screen.getByText('Dimension Maintenance')).toBeInTheDocument();
      expect(screen.getByText('1 pending / 1 suspended')).toBeInTheDocument();
      expect(screen.getByText('Migration')).toBeInTheDocument();
      expect(screen.getByText('2 attempts')).toBeInTheDocument();
      expect(screen.getByText('Crash Recovery')).toBeInTheDocument();
      expect(screen.getByText('pending')).toBeInTheDocument();
      expect(screen.getByText('Runtime Metrics')).toBeInTheDocument();
      expect(screen.getByText('1 process')).toBeInTheDocument();
    });
  });

  describe('database status', () => {
    it('shows loading state when database is connecting', () => {
      useDatabaseStatusStore.getState().setLoading();
      render(<SystemDiagnosticsPanel />);

      expect(screen.getByText('Connecting...')).toBeInTheDocument();
    });

    it('shows connected state with location', () => {
      useDatabaseStatusStore.getState().setConnected('In-Browser', '1 + 1 = 2');
      render(<SystemDiagnosticsPanel />);

      expect(screen.getByText('Connected')).toBeInTheDocument();
      expect(screen.getByText('In-Browser')).toBeInTheDocument();
      expect(screen.getByText('1 + 1 = 2')).toBeInTheDocument();
      expect(screen.getByText('Database is operational')).toBeInTheDocument();
    });

    it('shows IPC location for Main Process', () => {
      useDatabaseStatusStore.getState().setConnected('Main Process', '42');
      render(<SystemDiagnosticsPanel />);

      expect(screen.getByText('IPC (Main Process)')).toBeInTheDocument();
    });

    it('shows disconnected state', () => {
      useDatabaseStatusStore.getState().setDisconnected('Unknown', 'Error');
      render(<SystemDiagnosticsPanel />);

      expect(screen.getByText('Disconnected')).toBeInTheDocument();
      expect(screen.getByText('Database connection failed')).toBeInTheDocument();
    });
  });

  describe('token cache worker status', () => {
    it('shows not ready when token cache is not operational', () => {
      render(<SystemDiagnosticsPanel tokenCacheOperational={false} />);

      expect(screen.getByText('Not Ready')).toBeInTheDocument();
      expect(screen.getByText('Token counting worker is not running')).toBeInTheDocument();
    });

    it('shows memory only when operational but not persisted', () => {
      render(
        <SystemDiagnosticsPanel
          persistenceMode="memory"
          tokenCacheOperational={true}
          tokenCachePersisted={false}
        />
      );

      expect(screen.getByText('Memory Only')).toBeInTheDocument();
      expect(
        screen.getByText('Token counts are in-memory only (no persistence)')
      ).toBeInTheDocument();
    });

    it('shows fully operational when both operational and persisted', () => {
      render(
        <SystemDiagnosticsPanel
          persistenceMode="persistent"
          tokenCacheOperational={true}
          tokenCachePersisted={true}
        />
      );

      expect(screen.getByText('Fully Operational')).toBeInTheDocument();
      expect(screen.getByText('Token counts are saved to database')).toBeInTheDocument();
    });

    it('displays operational and persisted flags', () => {
      render(
        <SystemDiagnosticsPanel
          persistenceMode="persistent"
          tokenCacheOperational={true}
          tokenCachePersisted={true}
        />
      );

      // Find the worker section by looking for operational/persisted labels and values
      expect(screen.getByText('Operational')).toBeInTheDocument();
      expect(screen.getByText('Persisted')).toBeInTheDocument();
      expect(screen.getByText('Mode')).toBeInTheDocument();

      // Check that there are two "Yes" values displayed
      const yesElements = screen.getAllByText('Yes');
      expect(yesElements).toHaveLength(2);
    });
  });

  describe('refresh functionality', () => {
    it('clicking refresh all triggers component re-render', async () => {
      const user = userEvent.setup();
      render(<SystemDiagnosticsPanel />);

      const refreshButton = screen.getByRole('button', { name: /refresh all diagnostics/i });
      await user.click(refreshButton);

      // Button should be disabled briefly during refresh
      expect(refreshButton).toBeDisabled();

      // Wait for refresh to complete
      await vi.waitFor(() => {
        expect(refreshButton).not.toBeDisabled();
      });
    });

    it('passes showQueueRefresh prop to QueueDiagnosticsPanel', () => {
      render(<SystemDiagnosticsPanel showQueueRefresh={false} />);

      return waitFor(() => {
        const queuePanel = screen.getByTestId('queue-diagnostics-panel');
        expect(queuePanel).toHaveAttribute('data-show-refresh', 'false');
      });
    });
  });
});

describe('createSystemDiagnosticsSettingsCategory', () => {
  beforeEach(() => {
    __resetDatabaseStatusStoreForTests();
    mockUseOptionalTokenCacheContext.mockReturnValue(null);
  });

  afterEach(() => {
    __resetDatabaseStatusStoreForTests();
    vi.clearAllMocks();
  });

  it('returns a valid settings category', () => {
    const category = createSystemDiagnosticsSettingsCategory();

    expect(category.id).toBe('system-diagnostics');
    expect(category.title).toBe('System Diagnostics');
    expect(category.description).toBe('Monitor database, queue, and worker health in real-time.');
    expect(category.keywords).toContain('diagnostics');
    expect(category.keywords).toContain('health');
    expect(category.keywords).toContain('database');
    expect(category.icon).toBeDefined();
    expect(category.content).toBeTruthy();
  });

  it('renders SystemDiagnosticsPanel when content is rendered', () => {
    const category = createSystemDiagnosticsSettingsCategory();
    render(category.content);

    expect(screen.getByText('System Diagnostics')).toBeInTheDocument();
  });

  it('reads token cache state from context when available', () => {
    // Mock the context to return operational token cache
    mockUseOptionalTokenCacheContext.mockReturnValue({
      isOperational: true,
      isPersisted: true,
      persistenceMode: 'persistent',
    });

    const category = createSystemDiagnosticsSettingsCategory();
    render(category.content);

    // Verify the panel shows the correct status from context
    expect(screen.getByText('Fully Operational')).toBeInTheDocument();
    expect(screen.getByText('Token counts are saved to database')).toBeInTheDocument();
  });

  it('shows default state when context is not available', () => {
    // Mock the context to return null (no provider)
    mockUseOptionalTokenCacheContext.mockReturnValue(null);

    const category = createSystemDiagnosticsSettingsCategory();
    render(category.content);

    // Verify the panel shows default "Not Ready" state
    expect(screen.getByText('Not Ready')).toBeInTheDocument();
    expect(screen.getByText('Token counting worker is not running')).toBeInTheDocument();
  });

  it('shows memory-only state when operational but not persisted', () => {
    mockUseOptionalTokenCacheContext.mockReturnValue({
      isOperational: true,
      isPersisted: false,
      persistenceMode: 'memory',
    });

    const category = createSystemDiagnosticsSettingsCategory();
    render(category.content);

    expect(screen.getByText('Memory Only')).toBeInTheDocument();
    expect(
      screen.getByText('Token counts are in-memory only (no persistence)')
    ).toBeInTheDocument();
  });
});
