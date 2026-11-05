import { INTERNAL_FAULT } from '@brainstrike/assistant-contract/boundary-failure';
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import { act } from '@brainstrike/test-utils/react-act';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useDatabaseStatusSync } from '../hooks/use-database-status-sync.ts';
import { useDatabaseStatusStore } from '../stores/database-status-store.ts';

describe('useDatabaseStatusSync', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('reports the native writer only after its catalog read', async () => {
    const pending = Promise.withResolvers<BoundaryResult<{ models: []; providers: [] }>>();
    vi.stubGlobal('modelCatalog', { read: () => pending.promise });
    renderHook(() => useDatabaseStatusSync());
    expect(useDatabaseStatusStore.getState().loading).toBe(true);
    await act(async () => pending.resolve({ ok: true, value: { models: [], providers: [] } }));
    expect(useDatabaseStatusStore.getState()).toMatchObject({
      connected: true,
      loading: false,
      location: 'SQLite',
    });
  });
  it('reports a failed native writer', async () => {
    vi.stubGlobal('modelCatalog', {
      read: async () => ({ error: INTERNAL_FAULT, ok: false }),
    });
    renderHook(() => useDatabaseStatusSync());
    await waitFor(() =>
      expect(useDatabaseStatusStore.getState()).toMatchObject({
        connected: false,
        loading: false,
        location: 'SQLite',
        testResult: INTERNAL_FAULT.message,
      })
    );
  });

  it('keeps loading when the model catalog is not available', () => {
    renderHook(() => useDatabaseStatusSync());

    const state = useDatabaseStatusStore.getState();
    expect(state.loading).toBe(true);
    expect(state.connected).toBe(false);
  });
});
