import { useEffect, useState } from 'react';

interface DatabaseStartupGraceOptions {
  readonly databaseError: Error | null;
  readonly databaseInitializing: boolean;
  readonly repositoryReady: boolean;
}

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
    }, 0);

    return () => {
      clearTimeout(timeoutId);
    };
  }, [databaseError, databaseInitializing, repositoryReady]);

  return !(repositoryReady || databaseError) && (databaseInitializing || startupGraceActive);
}
