/**
 * Direct unit coverage for the shared prune statement builder (BST-991
 * slice 2 review). The two SQL shapes are exercised end-to-end by the
 * real-PGlite maintenance tests; these pin the parts only visible at the
 * builder seam — the guards and the parameter-offset difference between the
 * unbounded ($2+) and bounded ($3+) shapes.
 */
import { describe, expect, it } from 'vitest';
import { buildPruneJobsStatement } from '../src/queue/job-queue.js';

describe('buildPruneJobsStatement', () => {
  it('builds the unbounded shape with states from $2', () => {
    const { params, sql } = buildPruneJobsStatement(
      ['succeeded', 'failed'],
      '2026-01-01T00:00:00Z'
    );
    expect(sql).toContain('WHERE updated_at < $1');
    expect(sql).toContain('state IN ($2,$3)');
    expect(sql).not.toContain('LIMIT');
    expect(params).toEqual(['2026-01-01T00:00:00Z', 'succeeded', 'failed']);
  });

  it('builds the bounded shape with LIMIT $2 and states from $3', () => {
    const { params, sql } = buildPruneJobsStatement(
      ['succeeded', 'canceled'],
      '2026-01-01T00:00:00Z',
      500
    );
    expect(sql).toContain('LIMIT $2');
    expect(sql).toContain('state IN ($3,$4)');
    expect(params).toEqual(['2026-01-01T00:00:00Z', 500, 'succeeded', 'canceled']);
  });

  it('rejects a missing cutoff and an empty state list before touching the DB', () => {
    expect(() => buildPruneJobsStatement(['succeeded'], '')).toThrow('olderThanIso is required');
    // Reachable via queue-cli: sanitizeStates filters unknown tokens without
    // rejecting them, so `prune --states bogus` yields []. Previously this
    // reached PGlite as the syntax error `state IN ()`; now it fails loudly
    // at the builder.
    expect(() => buildPruneJobsStatement([], '2026-01-01T00:00:00Z')).toThrow(
      'At least one job state is required to prune'
    );
  });

  it('rejects a zero, negative, or fractional limit instead of emitting LIMIT 0', () => {
    for (const limit of [0, -5, 1.5]) {
      expect(() => buildPruneJobsStatement(['succeeded'], '2026-01-01T00:00:00Z', limit)).toThrow(
        'Prune limit must be a positive integer'
      );
    }
  });
});
