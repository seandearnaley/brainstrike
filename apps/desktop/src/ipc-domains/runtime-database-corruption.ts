export type RuntimeDatabaseCorruptionHandler = (context: string) => Promise<void>;

export const DATABASE_CORRUPTION_RECOVERED_MESSAGE =
  'Database corruption was recovered by resetting local index data. Brainstrike is reloading.';

/**
 * Runtime corruption recovery is destructive: the old database is replaced.
 * The operation that observed corruption must never be replayed against that
 * empty replacement because its foreign-key context and transaction snapshot
 * belonged to the old database.
 */
export async function recoverRuntimeDatabaseCorruption(
  context: string,
  handler?: RuntimeDatabaseCorruptionHandler
): Promise<never> {
  if (handler) {
    await handler(context);
  } else {
    const { handleRuntimeCorruption } = await import('../db-main');
    await handleRuntimeCorruption(context);
  }

  const error = new Error(DATABASE_CORRUPTION_RECOVERED_MESSAGE);
  error.name = 'DatabaseCorruptionRecoveredError';
  throw error;
}
