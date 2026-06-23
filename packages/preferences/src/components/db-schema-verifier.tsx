/**
 * DbSchemaVerifier Component
 *
 * Sets schemaVerified flag when the PGlite database is ready.
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

import { useBrainstrikeDbClient } from '@brainstrike/db';
import type React from 'react';
import { useEffect } from 'react';
import { useVectorStatusUIStore } from '../stores/vector-status-ui-store';

export interface DbSchemaVerifierProps {
  children: React.ReactNode;
}

export function DbSchemaVerifier({ children }: DbSchemaVerifierProps): React.ReactElement {
  const db = useBrainstrikeDbClient();
  const setSchemaVerified = useVectorStatusUIStore((s) => s.setSchemaVerified);

  useEffect(() => {
    if (!db) {
      return;
    }
    // Database is ready (migrations have run in DbProvider), set schemaVerified
    // Defer to avoid synchronous setState in effect body (React Compiler requirement)
    const timer = setTimeout(() => {
      setSchemaVerified(true);
    }, 0);
    return () => {
      clearTimeout(timer);
    };
  }, [db, setSchemaVerified]);

  return <>{children}</>;
}
