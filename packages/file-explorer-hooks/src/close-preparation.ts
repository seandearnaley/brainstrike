import { createLogger } from '@brainstrike/logging';

export type ClosePreparationRegistrar = (prepare: () => Promise<void>) => () => void;
interface ClosePreparationOwner {
  drain(): Promise<void>;
  prepareClose(): Promise<void>;
}
const logger = createLogger('ExplorerClose');

/** Keep a detached store's admitted work in the existing close join until idle. */
export function registerClosePreparation(
  owner: ClosePreparationOwner,
  register: ClosePreparationRegistrar
): () => void {
  let detached: Promise<void> | undefined;
  const unregister = register(async () => {
    const results = await Promise.allSettled([owner.prepareClose(), detached]);
    const failures = [
      ...new Set(
        results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
      ),
    ];
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Explorer owners failed to settle');
    }
  });
  return () => {
    // StrictMode cleanup does not terminal-fence a store mounted again. Every
    // effect setup owns a distinct callback, so old cleanup cannot remove it.
    if (detached) {
      return;
    }
    detached = owner.drain();
    void detached.then(unregister, (error: unknown) => {
      logger.error('Detached Explorer owner failed to settle', {
        errorName: error instanceof Error ? error.name : typeof error,
      });
    });
  };
}
