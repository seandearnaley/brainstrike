import { MAX_SEARCH_RESULT_LIMIT } from '@brainstrike/db';
import { RESULT_LIMIT_MAX } from '@brainstrike/ui';
import { describe, expect, it } from 'vitest';

/**
 * Cross-layer invariant: the UI free-input result-limit ceiling
 * (`RESULT_LIMIT_MAX`, @brainstrike/ui) must never exceed the web repository's
 * hard cap (`MAX_SEARCH_RESULT_LIMIT`, DrizzleFileChunkRepository.searchSimilar).
 *
 * The two live in different packages (ui can't depend on db), so they can't
 * share one constant — this test in db-explorer (which depends on both) is the
 * guard that keeps them from silently diverging. If they diverge, web search
 * throws for limits between the repo cap and the UI ceiling.
 */
describe('result-limit ceiling reconciliation', () => {
  it('keeps the UI ceiling within the repository cap so web search never throws', () => {
    expect(RESULT_LIMIT_MAX).toBeLessThanOrEqual(MAX_SEARCH_RESULT_LIMIT);
  });
});
