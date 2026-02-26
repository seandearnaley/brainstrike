import { createWithEqualityFn as create } from 'zustand/traditional';

export interface DatabaseStatusState {
  connected: boolean;
  loading: boolean;
  location: string | null;
  testResult: string | null;
}

export interface DatabaseStatusActions {
  reset: () => void;
  setConnected: (location: string, testResult: string) => void;
  setDisconnected: (location: string, testResult: string) => void;
  setLoading: () => void;
}

export type DatabaseStatusStore = DatabaseStatusState & DatabaseStatusActions;

/**
 * Global store for database connection status.
 * Used by the status bar to display connection state.
 * Does not persist - connection state is determined at runtime.
 */
export const useDatabaseStatusStore = create<DatabaseStatusStore>()((set) => ({
  location: null,
  testResult: null,
  connected: false,
  loading: true,
  setConnected: (location, testResult) =>
    set({ location, testResult, connected: true, loading: false }),
  setDisconnected: (location, testResult) =>
    set({ location, testResult, connected: false, loading: false }),
  setLoading: () => set({ loading: true, connected: false }),
  reset: () => set({ location: null, testResult: null, connected: false, loading: true }),
}));

export const databaseStatusSelectors = {
  isConnected: (s: DatabaseStatusStore) => s.connected,
  isLoading: (s: DatabaseStatusStore) => s.loading,
  location: (s: DatabaseStatusStore) => s.location,
  testResult: (s: DatabaseStatusStore) => s.testResult,
};

export function __resetDatabaseStatusStoreForTests() {
  useDatabaseStatusStore.setState({
    location: null,
    testResult: null,
    connected: false,
    loading: true,
  });
}
