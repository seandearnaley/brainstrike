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
