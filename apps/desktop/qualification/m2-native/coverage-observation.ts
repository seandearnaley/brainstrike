import type { IndexerCoverageInvalidatedObservation } from '../../../../packages/indexing-contract/src/indexer-client';
import { NATIVE_COVERAGE_OBSERVATION_INVALIDATED } from '../../src/native-coverage-observation-invalidated.ts';

export type CoverageObservation<T> =
  | { readonly kind: 'current'; readonly value: T }
  | IndexerCoverageInvalidatedObservation;

export async function observeCoverage<T>(
  read: () => Promise<CoverageObservation<T>>,
  record: (phase: string, value: unknown) => Promise<void>
): Promise<CoverageObservation<T>> {
  const observation = await read();
  if (observation.kind === 'invalidated') {
    if (observation.code !== NATIVE_COVERAGE_OBSERVATION_INVALIDATED) {
      throw new Error('Unexpected coverage observation failure code.');
    }
    await record('coverage-observation-invalidated', observation);
  }
  return observation;
}

/** Return the last fresh observation only after the caller's existing poll predicate succeeds. */
export async function waitForCurrentObservation<T>(
  read: () => Promise<T | null>,
  wait: (read: () => Promise<T | null>) => Promise<void>
): Promise<T> {
  let current: T | null = null;
  await wait(async () => {
    current = null;
    current = await read();
    return current;
  });
  if (current === null) {
    throw new Error('Completed observation wait has no current observation.');
  }
  return current;
}
