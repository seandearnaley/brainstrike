// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetDatabaseStatusStoreForTests,
  databaseStatusSelectors,
  useDatabaseStatusStore,
} from '../stores/database-status-store';

describe('database-status-store', () => {
  beforeEach(() => {
    __resetDatabaseStatusStoreForTests();
  });

  it('starts in loading state', () => {
    const state = useDatabaseStatusStore.getState();
    expect(state.loading).toBe(true);
    expect(state.connected).toBe(false);
    expect(state.location).toBeNull();
    expect(state.testResult).toBeNull();
  });

  it('setConnected updates state correctly', () => {
    const store = useDatabaseStatusStore.getState();
    store.setConnected('Main Process', 'Connected (IPC)');

    const state = useDatabaseStatusStore.getState();
    expect(state.connected).toBe(true);
    expect(state.loading).toBe(false);
    expect(state.location).toBe('Main Process');
    expect(state.testResult).toBe('Connected (IPC)');
  });

  it('setDisconnected updates state correctly', () => {
    const store = useDatabaseStatusStore.getState();
    store.setDisconnected('Unknown', 'Connection failed');

    const state = useDatabaseStatusStore.getState();
    expect(state.connected).toBe(false);
    expect(state.loading).toBe(false);
    expect(state.location).toBe('Unknown');
    expect(state.testResult).toBe('Connection failed');
  });

  it('setLoading resets to loading state', () => {
    // First set connected state
    const store = useDatabaseStatusStore.getState();
    store.setConnected('PGlite WASM', 'OK');

    expect(useDatabaseStatusStore.getState().connected).toBe(true);

    // Then call setLoading
    store.setLoading();

    const state = useDatabaseStatusStore.getState();
    expect(state.loading).toBe(true);
    expect(state.connected).toBe(false);
    // Location and testResult are preserved
  });

  it('reset returns to initial state', () => {
    const store = useDatabaseStatusStore.getState();
    store.setConnected('Main Process', 'OK');

    store.reset();

    const state = useDatabaseStatusStore.getState();
    expect(state.loading).toBe(true);
    expect(state.connected).toBe(false);
    expect(state.location).toBeNull();
    expect(state.testResult).toBeNull();
  });

  describe('selectors', () => {
    it('isConnected selector returns connected state', () => {
      const store = useDatabaseStatusStore.getState();
      expect(databaseStatusSelectors.isConnected(store)).toBe(false);

      store.setConnected('Test', 'OK');

      const updated = useDatabaseStatusStore.getState();
      expect(databaseStatusSelectors.isConnected(updated)).toBe(true);
    });

    it('isLoading selector returns loading state', () => {
      const store = useDatabaseStatusStore.getState();
      expect(databaseStatusSelectors.isLoading(store)).toBe(true);

      store.setConnected('Test', 'OK');

      const updated = useDatabaseStatusStore.getState();
      expect(databaseStatusSelectors.isLoading(updated)).toBe(false);
    });

    it('location selector returns location', () => {
      const store = useDatabaseStatusStore.getState();
      expect(databaseStatusSelectors.location(store)).toBeNull();

      store.setConnected('Main Process', 'OK');

      const updated = useDatabaseStatusStore.getState();
      expect(databaseStatusSelectors.location(updated)).toBe('Main Process');
    });

    it('testResult selector returns testResult', () => {
      const store = useDatabaseStatusStore.getState();
      expect(databaseStatusSelectors.testResult(store)).toBeNull();

      store.setConnected('Test', 'Connection successful');

      const updated = useDatabaseStatusStore.getState();
      expect(databaseStatusSelectors.testResult(updated)).toBe('Connection successful');
    });
  });

  describe('state transitions', () => {
    it('loading -> connected', () => {
      expect(useDatabaseStatusStore.getState().loading).toBe(true);

      useDatabaseStatusStore.getState().setConnected('PGlite', 'OK');

      const state = useDatabaseStatusStore.getState();
      expect(state.loading).toBe(false);
      expect(state.connected).toBe(true);
    });

    it('loading -> disconnected', () => {
      expect(useDatabaseStatusStore.getState().loading).toBe(true);

      useDatabaseStatusStore.getState().setDisconnected('Unknown', 'Failed');

      const state = useDatabaseStatusStore.getState();
      expect(state.loading).toBe(false);
      expect(state.connected).toBe(false);
    });

    it('connected -> disconnected', () => {
      useDatabaseStatusStore.getState().setConnected('PGlite', 'OK');
      expect(useDatabaseStatusStore.getState().connected).toBe(true);

      useDatabaseStatusStore.getState().setDisconnected('Unknown', 'Lost connection');

      const state = useDatabaseStatusStore.getState();
      expect(state.connected).toBe(false);
      expect(state.testResult).toBe('Lost connection');
    });

    it('connected -> loading -> connected', () => {
      useDatabaseStatusStore.getState().setConnected('PGlite', 'OK');

      useDatabaseStatusStore.getState().setLoading();
      expect(useDatabaseStatusStore.getState().loading).toBe(true);

      useDatabaseStatusStore.getState().setConnected('Main Process', 'Reconnected');

      const state = useDatabaseStatusStore.getState();
      expect(state.loading).toBe(false);
      expect(state.connected).toBe(true);
      expect(state.location).toBe('Main Process');
    });
  });
});
