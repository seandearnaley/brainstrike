import { useEffect, useState } from 'react';

interface DatabaseStartupGraceOptions {
  readonly databaseError: Error | null;
  readonly databaseInitializing: boolean;
  readonly repositoryReady: boolean;
}

// Bridges the first render before DbProvider's initializeDatabase effect can
// synchronously set initializing=true; it is not intended to mask slow startup.
const DATABASE_STARTUP_GRACE_MS = 250;

export function useDatabaseStartupGrace({
  databaseError,
  databaseInitializing,
  repositoryReady,
}: DatabaseStartupGraceOptions): boolean {
  const [startupGraceActive, setStartupGraceActive] = useState(true);

  useEffect(() => {
    if (repositoryReady || databaseInitializing || databaseError) {
      setStartupGraceActive(true);
      return;
    }

    const timeoutId = setTimeout(() => {
      setStartupGraceActive(false);
    }, DATABASE_STARTUP_GRACE_MS);

    return () => {
      clearTimeout(timeoutId);
    };
  }, [databaseError, databaseInitializing, repositoryReady]);

  return !(repositoryReady || databaseError) && (databaseInitializing || startupGraceActive);
}
