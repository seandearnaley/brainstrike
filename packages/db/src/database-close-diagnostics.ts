import { createLogger } from '@brainstrike/logging';

const logger = createLogger('DbProvider');

/** Keep cleanup non-throwing; only the exact closed sentinel is benign. */
export function reportDatabaseCloseFailure(
  err: unknown,
  storage: 'browser-persistent' | 'direct'
): void {
  // Worker transports can deliver an Error from another realm.
  if (
    typeof err === 'object' &&
    err !== null &&
    'message' in err &&
    err.message === 'PGlite is closed'
  ) {
    return;
  }
  logger.error('Failed to close database:', { code: 'database_close_failed', err, storage });
}
