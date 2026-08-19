import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRecordArrayWeakReference,
  useDatabaseDemoTestHook,
} from '../use-database-demo-test-hook';

const databaseTelemetrySnapshot = vi.hoisted(() =>
  vi.fn(() => ({ activeLiveSubscriptions: 3, liveUpdateCount: 17 }))
);

vi.mock('@brainstrike/db', () => ({
  databaseQueryTelemetry: { snapshot: databaseTelemetrySnapshot },
}));

const cacheDiagnostics = {
  cachedChunkPageEntries: 0,
  cachedCollectionCountEntries: 1,
  cachedRecordPageEntries: 1,
  cachedRecordTotalEntries: 1,
  loadedRecordPageEntries: 1,
};

describe('useDatabaseDemoTestHook memory diagnostics', () => {
  beforeEach(() => {
    window.desktopLifecycle = { isTestMode: true };
    window.__brainstrikeDatabaseDemoTestHooks__ = undefined;
    databaseTelemetrySnapshot.mockClear();
  });

  afterEach(() => {
    window.__brainstrikeDatabaseDemoTestHooks__ = undefined;
    window.desktopLifecycle = undefined;
  });

  it('tracks bounded opaque record-array generations without retaining row payloads', async () => {
    const firstRecords = [{ id: 'record-a' }, { id: 'record-b' }];
    const view = renderHook(
      ({ records }: { records: readonly { readonly id: string }[] }) =>
        useDatabaseDemoTestHook({
          activeCollectionId: 'collection-a',
          getCacheDiagnostics: () => cacheDiagnostics,
          isImporting: false,
          recordCount: records.length,
          recordCurrentPage: 0,
          recordPageSize: 50,
          records,
          recordTotalRecords: records.length,
        }),
      { initialProps: { records: firstRecords } }
    );

    await waitFor(() => {
      expect(window.__brainstrikeDatabaseDemoTestHooks__).toBeDefined();
    });
    expect(window.__brainstrikeDatabaseDemoTestHooks__?.getMemorySnapshot()).toMatchObject({
      recordArrayRetention: {
        aliveGenerations: [1],
        currentGeneration: 1,
        droppedGenerationCount: 0,
        trackedGenerationCount: 1,
      },
    });

    view.rerender({ records: firstRecords });
    expect(window.__brainstrikeDatabaseDemoTestHooks__?.getMemorySnapshot()).toMatchObject({
      recordArrayRetention: {
        currentGeneration: 1,
        trackedGenerationCount: 1,
      },
    });

    view.rerender({ records: [] });
    await waitFor(() => {
      expect(
        window.__brainstrikeDatabaseDemoTestHooks__?.getMemorySnapshot().recordArrayRetention
          .currentGeneration
      ).toBeNull();
    });
    view.rerender({ records: firstRecords });
    await waitFor(() => {
      expect(
        window.__brainstrikeDatabaseDemoTestHooks__?.getMemorySnapshot().recordArrayRetention
          .currentGeneration
      ).toBe(2);
    });

    view.rerender({ records: [{ id: 'record-c' }] });
    await waitFor(() => {
      expect(
        window.__brainstrikeDatabaseDemoTestHooks__?.getMemorySnapshot().recordArrayRetention
          .currentGeneration
      ).toBe(3);
    });
    expect(window.__brainstrikeDatabaseDemoTestHooks__?.getMemorySnapshot()).not.toHaveProperty(
      'records'
    );
  });

  it('caps record identifiers in the test snapshot without exposing record objects', async () => {
    const records = Array.from({ length: 101 }, (_, index) => ({ id: `record-${index}` }));
    renderHook(() =>
      useDatabaseDemoTestHook({
        activeCollectionId: 'collection-a',
        getCacheDiagnostics: () => cacheDiagnostics,
        isImporting: false,
        recordCount: records.length,
        recordCurrentPage: 0,
        recordPageSize: 101,
        records,
        recordTotalRecords: records.length,
      })
    );

    await waitFor(() => {
      expect(window.__brainstrikeDatabaseDemoTestHooks__).toBeDefined();
    });
    const snapshot = window.__brainstrikeDatabaseDemoTestHooks__?.getMemorySnapshot();
    expect(snapshot?.recordIds).toHaveLength(100);
    expect(snapshot).not.toHaveProperty('records');
  });

  it('bounds the WeakRef generation ledger and exposes every dropped observation', async () => {
    const view = renderHook(
      ({ records }: { records: readonly { readonly id: string }[] }) =>
        useDatabaseDemoTestHook({
          activeCollectionId: 'collection-a',
          getCacheDiagnostics: () => cacheDiagnostics,
          isImporting: false,
          recordCount: records.length,
          recordCurrentPage: 0,
          recordPageSize: 50,
          records,
          recordTotalRecords: records.length,
        }),
      { initialProps: { records: [{ id: 'generation-0' }] } }
    );

    for (let generation = 1; generation <= 256; generation += 1) {
      view.rerender({ records: [{ id: `generation-${generation}` }] });
    }

    await waitFor(() => {
      expect(
        window.__brainstrikeDatabaseDemoTestHooks__?.getMemorySnapshot().recordArrayRetention
      ).toMatchObject({
        currentGeneration: 257,
        droppedGenerationCount: 1,
        trackedGenerationCount: 256,
      });
    });
  });

  it('fails closed when WeakRef diagnostics are unavailable', () => {
    vi.stubGlobal('WeakRef', undefined);
    try {
      expect(() => createRecordArrayWeakReference([{ id: 'record-a' }])).toThrow(
        'Database memory test diagnostics require WeakRef support.'
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not install the memory hook outside explicit desktop test mode', () => {
    window.desktopLifecycle = { isTestMode: false };

    renderHook(() =>
      useDatabaseDemoTestHook({
        activeCollectionId: null,
        getCacheDiagnostics: () => cacheDiagnostics,
        isImporting: false,
        recordCount: 0,
        recordCurrentPage: 0,
        recordPageSize: 50,
        records: [],
        recordTotalRecords: 0,
      })
    );

    expect(window.__brainstrikeDatabaseDemoTestHooks__).toBeUndefined();
  });
});
