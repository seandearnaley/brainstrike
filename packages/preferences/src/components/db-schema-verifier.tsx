/**
 * DbSchemaVerifier Component
 *
 * Sets schemaVerified flag when the selected database runtime is ready.
 * This ensures Vector Status collections can load regardless of
 * which panel opens first.
 *
 * Must be rendered inside DbProvider (from @brainstrike/db).
 *
 * Usage:
 * ```tsx
 * <DbProvider dbPath="idb://app">
 *   <DbSchemaVerifier>
 *     <App />
 *   </DbSchemaVerifier>
 * </DbProvider>
 * ```
 */

import {
  type DbInitializationStatus,
  type ProfileBootstrapReport,
  useBrainstrikeDbClient,
  useOptionalDbInitializationStatus,
  useOptionalProfileBootstrapReport,
} from '@brainstrike/db';
import type React from 'react';
import { useEffect } from 'react';
import { useVectorStatusUIStore } from '../stores/vector-status-ui-store';

export interface DbSchemaVerifierProps {
  children: React.ReactNode;
}

function isTursoSchemaReady(
  initializationStatus: DbInitializationStatus,
  report: ProfileBootstrapReport | null
): boolean {
  return (
    initializationStatus === 'ready' && report?.ready === true && report.runtime.engine === 'turso'
  );
}

export function DbSchemaVerifier({ children }: DbSchemaVerifierProps): React.ReactElement {
  const db = useBrainstrikeDbClient();
  const initializationStatus = useOptionalDbInitializationStatus();
  const profileBootstrapReport = useOptionalProfileBootstrapReport();
  const setSchemaVerified = useVectorStatusUIStore((s) => s.setSchemaVerified);
  const schemaReady =
    Boolean(db) || isTursoSchemaReady(initializationStatus, profileBootstrapReport);

  useEffect(() => {
    // Keep the global schema cache aligned with the current runtime readiness.
    // Defer to avoid synchronous setState in effect body (React Compiler requirement)
    const timer = setTimeout(() => {
      setSchemaVerified(schemaReady);
    }, 0);
    return () => {
      clearTimeout(timer);
    };
  }, [schemaReady, setSchemaVerified]);

  return <>{children}</>;
}
