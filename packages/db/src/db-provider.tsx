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
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
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
  // Both props are MOUNT-TIME configuration: the runtime and its transports are
  // built once per mount, so a later change could only take effect if a
  // transport were re-opened, which would silently swap the database out from
  // under live repositories. Every call site passes a constant
  // (`useElectronIPC={true}`, a module-level path, or a literal), so capturing
  // here states the real contract instead of implying a liveness nothing wants.
  // Reading them through a ref assigned during render is also what React
  // forbids (`no-ref-current-in-render`).

  // Lazy useState initializer, not useRef(create()): a ref initializer
  // expression would rebuild-and-discard the runtime on every render
  // (react-doctor rerender-lazy-ref-init); useState runs the factory once.
  // Transport ORDER is the selection policy: the capability-probed desktop
  // bridge first, the always-available renderer PGlite last.
  const [runtime] = useState(() =>
    createDatabaseRuntime({
      transports: [
        createElectronIpcTransport({ isEnabled: () => useElectronIPC === true }),
        createPgliteDirectTransport({
          getDataDir: () => dbPath ?? getDefaultDbPath(),
        }),
      ],
    })
  );

  const state = useSyncExternalStore(runtime.subscribe, runtime.getState, runtime.getState);

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
    // `runtime` is created once by the lazy useState initializer, so this is a
    // mount/unmount effect in practice. Depending on it rather than suppressing
    // the rule keeps that honest: if the runtime identity ever did change, the
    // old one would be disposed and the new one started, which is correct.
  }, [runtime]);

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
