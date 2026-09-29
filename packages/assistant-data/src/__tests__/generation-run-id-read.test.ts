/**
 * ONE ROW OR NONE (BST-1749, final review item 1). Every predicate behind a
 * generation read is a primary key — `brainstrike_assistant_native_runs`'
 * `native_run_id`, a continuation's `id`, an invocation's
 * `(root_thread_id, parent_runtime_run_id, parent_tool_call_id)` — joined to
 * its owner leg by `id`. A second row therefore means the assumption the read
 * rests on is wrong, and the repository says so rather than taking the first
 * row of an unordered result.
 */
import { describe, expect, it } from 'vitest';
import { readSoleGenerationRunId } from '../assistant-memory-repository';

describe('readSoleGenerationRunId', () => {
  it('reads the generation a single matching row names', () => {
    expect(readSoleGenerationRunId([{ generationRunId: 'initial-leg' }])).toBe('initial-leg');
  });

  it('reports no generation when nothing matches, and never invents one', () => {
    expect(readSoleGenerationRunId([])).toBeNull();
  });

  it('treats a NULL or empty generation as an absence, not an identity', () => {
    expect(readSoleGenerationRunId([{ generationRunId: null }])).toBeNull();
    expect(readSoleGenerationRunId([{ generationRunId: '' }])).toBeNull();
  });

  it('refuses an ambiguous read instead of picking a row out of an unordered result', () => {
    expect(() =>
      readSoleGenerationRunId([{ generationRunId: 'initial-leg' }, { generationRunId: 'other' }])
    ).toThrow(/matched 2 rows/);
  });
});
