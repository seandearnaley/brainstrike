import { makeThrowingDecoder } from '@brainstrike/effect-kit';
import {
  IndexerError,
  type IndexerPort,
  type ScopedCoverage,
  type ScopedIndexerPort,
} from '@brainstrike/indexer';
import {
  assertCoverageAuthority,
  type CoverageAuthority,
  type CoverageAuthorityPort,
  scopedCoverageBatchRequestSchema,
} from '@brainstrike/indexer/coverage-reader';
import type { SqliteQueryClient } from '@brainstrike/sqlite-query';
import { NativeAuthorityTransitionError } from './native-authority-transition';

export type NativeCoverageReader = Pick<SqliteQueryClient, 'nativeCoverage' | 'close'>;

/** Every call owns and physically joins a fresh isolated coverage reader. */
export function isolateNativeCoverage(
  port: IndexerPort & ScopedIndexerPort & CoverageAuthorityPort,
  open: (authority: CoverageAuthority) => Promise<NativeCoverageReader>
): IndexerPort & ScopedIndexerPort & CoverageAuthorityPort {
  const coverageBatch: ScopedIndexerPort['coverageBatch'] = async (input) => {
    const requests = makeThrowingDecoder(scopedCoverageBatchRequestSchema)(input);
    const authority = await port.coverageAuthority();
    const reader = await open(authority);
    let result: readonly ScopedCoverage[];
    try {
      result = await reader.nativeCoverage(requests);
      for (const observation of result) {
        assertCoverageAuthority(observation, authority);
      }
      assertCoverageAuthority(await port.coverageAuthority(), authority);
    } catch (work) {
      try {
        await reader.close();
      } catch (cleanup) {
        throw new AggregateError(
          [work, cleanup],
          'Native coverage and owned reader cleanup failed.',
          { cause: work }
        );
      }
      if (work instanceof IndexerError && work.code === 'coverage-authority-changed') {
        const current = await port.coverageAuthority();
        if (
          current.storeId === authority.storeId &&
          (current.authorityEpoch !== authority.authorityEpoch ||
            current.authorityRevision !== authority.authorityRevision)
        ) {
          throw new NativeAuthorityTransitionError(
            'Native coverage authority changed during observation.'
          );
        }
      }
      throw work;
    }
    await reader.close();
    return result;
  };
  return {
    ...port,
    coverageBatch,
    coverageScope: async (request) => {
      const [result] = await coverageBatch([request]);
      if (!result) {
        throw new Error('Native singleton coverage returned no result.');
      }
      return result;
    },
  };
}
