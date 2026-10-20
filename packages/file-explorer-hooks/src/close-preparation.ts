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

/** One provider admission retains both phases until all detached work settles. */
export function registerClosePreparationPair(
  owners: {
    readonly producers: ClosePreparationOwner;
    readonly persistence: ClosePreparationOwner;
    readonly begin: () => void;
  },
  register: (owner: {
    readonly prepareProducers: () => Promise<void>;
    readonly preparePersistence: () => Promise<void>;
    readonly begin: () => void;
  }) => () => void
): () => void {
  let detached: Promise<void> | undefined;
  const settle = async (operations: readonly (Promise<unknown> | undefined)[]) => {
    const results = await Promise.allSettled(operations);
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
  };
  const unregister = register({
    begin: owners.begin,
    preparePersistence: () => settle([owners.persistence.prepareClose(), detached]),
    prepareProducers: () => settle([owners.producers.prepareClose(), detached]),
  });
  return () => {
    if (detached) {
      return;
    }
    detached = (async () => {
      const producers = await Promise.allSettled([owners.producers.drain()]);
      const persistence = owners.persistence.drain();
      await settle([
        persistence,
        ...producers.map((result) =>
          result.status === 'rejected' ? Promise.reject(result.reason) : undefined
        ),
      ]);
    })();
    void detached.then(unregister, (error: unknown) => {
      logger.error('Detached Explorer owner failed to settle', {
        errorName: error instanceof Error ? error.name : typeof error,
      });
    });
  };
}
