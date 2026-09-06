/**
 * The React shell over `database-runtime.ts`.
 *
 * Everything that is NOT React — the reducer, the two transports, the
 * BST-1329 drain ordering, factory reset — lives in `database-runtime.ts`,
 * `electron-ipc-transport.ts` and `pglite-direct-transport.ts`. This file only
 * builds the runtime once per mount, subscribes to it with
 * `useSyncExternalStore`, and publishes the context value. Keep it that way:
 * the lifecycle invariants are pinned by `database-runtime.test.ts`, which
 * runs without React, and putting logic back here puts it back out of reach.
 */
import type React from 'react';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createDatabaseRuntime } from './database-runtime.js';
import { DbContext, type DbContextValue } from './db-context.js';
import { getDefaultDbPath } from './default-db-path.js';
import { createElectronIpcTransport } from './electron-ipc-transport.js';
import { createPgliteDirectTransport } from './pglite-direct-transport.js';

interface DbProviderProps {
  children: React.ReactNode;
  dbPath?: string;
  useElectronIPC?: boolean;
}

export function DbProvider({ children, dbPath, useElectronIPC }: DbProviderProps) {
  // Props are read through refs so the runtime — built once per mount — always
  // sees the CURRENT prop, exactly like the old `useCallback` closures did.
  const dbPathRef = useRef<string | undefined>(dbPath);
  dbPathRef.current = dbPath;
  const useElectronIPCRef = useRef<boolean | undefined>(useElectronIPC);
  useElectronIPCRef.current = useElectronIPC;

  // Lazy useState initializer, not useRef(create()): a ref initializer
  // expression would rebuild-and-discard the runtime on every render
  // (react-doctor rerender-lazy-ref-init); useState runs the factory once.
  // Transport ORDER is the selection policy: the capability-probed desktop
  // bridge first, the always-available renderer PGlite last.
  const [runtime] = useState(() =>
    createDatabaseRuntime({
      transports: [
        createElectronIpcTransport({ isEnabled: () => useElectronIPCRef.current === true }),
        createPgliteDirectTransport({
          getDataDir: () => dbPathRef.current ?? getDefaultDbPath(),
        }),
      ],
    })
  );

  const state = useSyncExternalStore(runtime.subscribe, runtime.getState, runtime.getState);

  // biome-ignore lint/correctness/useExhaustiveDependencies: run once on mount/unmount; initialization guarded inside the runtime
  useEffect(() => {
    // No automatic initialization in prod/dev - only when explicitly requested.
    // In test environments, eagerly initialize to simplify test timing and ensure
    // constructor calls (e.g., default path detection) are observable.
    runtime.start(); // Provider is ready, but database is not yet loaded

    if (process.env['NODE_ENV'] === 'test') {
      // Fire and forget; the runtime's internal guards prevent duplicate
      // initialization and it never rejects.
      void runtime.initialize();
    }

    return () => {
      void runtime.dispose();
    };
  }, []);

  const contextValue = useMemo<DbContextValue>(
    () => ({
      chunkRepository: state.chunkRepository,
      clearAllData: runtime.clearAllData,
      clearQueuesAndEmbeddingSets: runtime.clearQueuesAndEmbeddingSets,
      db: state.exposedDb,
      drizzleDb: state.drizzleDb,
      embeddingSetsRepository: state.embeddingSetsRepository,
      error: state.error,
      factoryReset: runtime.factoryReset,
      fileRecordRepository: state.fileRecordRepository,
      initializationStatus: state.initializationStatus,
      initializeDatabase: runtime.initialize,
      initializing: state.initializing,
      liveQueryDrainRegistry: runtime.liveQueryDrainRegistry,
      ready: state.ready,
      vectorEnabled: state.vectorEnabled,
      viewFilterPresetsRepository: state.viewFilterPresetsRepository,
    }),
    [runtime, state]
  );

  return <DbContext.Provider value={contextValue}>{children}</DbContext.Provider>;
}

// The consumer hooks live in ./use-db.ts: mixing hook and component exports
// here would break the Vite Fast Refresh boundary (identity-based check).
