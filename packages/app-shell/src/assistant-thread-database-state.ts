import type { DbInitializationStatus } from '@brainstrike/db';

export function shouldRenderAssistantThreadDatabaseStartupLoading({
  databaseError,
  databaseInitializing,
  databaseStatus,
  repositoryReady,
}: {
  readonly databaseError: Error | null;
  readonly databaseInitializing: boolean;
  readonly databaseStatus: DbInitializationStatus;
  readonly repositoryReady: boolean;
}): boolean {
  if (repositoryReady || databaseError) {
    return false;
  }
  return databaseInitializing || databaseStatus === 'idle' || databaseStatus === 'initializing';
}
