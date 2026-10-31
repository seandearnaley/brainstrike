/**
 * The renderer's part in a factory reset: its writers retire, and nothing else.
 *
 * Main owns the reset (ADR-0015). It wipes userData and, once this document has
 * unloaded, the session's storage (localStorage, IndexedDB, CacheStorage) before
 * loading a fresh document, so no store here clears or resets itself. Preparation is terminal for
 * this renderer; the reset UI must reload on either outcome.
 */
const factoryResetPreparations = new Set<() => Promise<void>>();
let factoryResetPreparationStarted = false;

export function hasFactoryResetPreparationStarted(): boolean {
  return factoryResetPreparationStarted;
}

export function registerFactoryResetPreparation(prepare: () => Promise<void>): () => void {
  factoryResetPreparations.add(prepare);
  return () => {
    factoryResetPreparations.delete(prepare);
  };
}

export async function prepareFactoryReset(): Promise<void> {
  factoryResetPreparationStarted = true;
  const results = await Promise.allSettled(
    [...factoryResetPreparations].map(async (prepare) => await prepare())
  );
  const failures: unknown[] = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Factory reset renderer preparation failed');
  }
}
