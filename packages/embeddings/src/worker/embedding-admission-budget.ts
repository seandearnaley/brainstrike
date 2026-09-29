import { runAtPromiseBoundary } from '@brainstrike/effect-kit';
import { Effect, TxSemaphore } from 'effect';

export interface EmbeddingAdmissionBudget {
  inFlight(): Promise<number>;
  release(count: number): Promise<void>;
  tryReserve(requested: number): Promise<number>;
  waitForAvailable(signal: AbortSignal): Promise<void>;
}

class EmbeddingAdmissionReleaseError extends Error {
  readonly _tag = 'EmbeddingAdmissionReleaseError';

  constructor(count: number, reserved: number) {
    super(`Invalid embedding in-flight budget release: ${count} with ${reserved} reserved.`);
  }
}

/** Admission only: durable job completion, not inference, owns each granted slot. */
export async function createEmbeddingAdmissionBudget(
  capacity: number
): Promise<EmbeddingAdmissionBudget> {
  const semaphore = await runAtPromiseBoundary(TxSemaphore.make(capacity));
  return {
    inFlight: async (): Promise<number> =>
      capacity - (await runAtPromiseBoundary(TxSemaphore.available(semaphore))),
    release: async (count: number): Promise<void> => {
      if (count === 0) {
        return;
      }
      await runAtPromiseBoundary(
        Effect.tx(
          Effect.gen(function* () {
            const available = yield* TxSemaphore.available(semaphore);
            if (!Number.isSafeInteger(count) || count < 0 || available + count > capacity) {
              return yield* Effect.fail(
                new EmbeddingAdmissionReleaseError(count, capacity - available)
              );
            }
            yield* TxSemaphore.releaseN(semaphore, count);
          })
        )
      );
    },
    tryReserve: async (requested: number): Promise<number> => {
      if (!Number.isSafeInteger(requested) || requested <= 0) {
        throw new Error(`Invalid embedding in-flight budget request: ${requested}.`);
      }
      // No abort signal crosses this commit-to-Promise handoff. A concurrent
      // Stop still receives the grant and returns it in the caller's finally.
      return runAtPromiseBoundary(
        Effect.tx(
          Effect.gen(function* () {
            const available = yield* TxSemaphore.available(semaphore);
            const granted = Math.min(requested, available);
            if (granted > 0) {
              yield* TxSemaphore.acquireN(semaphore, granted);
            }
            return granted;
          })
        )
      );
    },
    waitForAvailable: (signal: AbortSignal): Promise<void> =>
      runAtPromiseBoundary(
        Effect.tx(
          Effect.gen(function* () {
            if ((yield* TxSemaphore.available(semaphore)) === 0) {
              return yield* Effect.txRetry;
            }
          })
        ),
        { signal }
      ),
  };
}
