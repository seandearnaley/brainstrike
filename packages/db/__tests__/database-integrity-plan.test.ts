import { describe, expect, it } from 'vitest';
import { planWalksIndex } from '../src/database-integrity-diagnosis.js';

const scan = (overrides: Record<string, unknown> = {}) => ({
  'Index Name': 'idx',
  'Node Type': 'Index Scan',
  'Order By': '(emb <=> $1)',
  'Parent Relationship': 'Outer',
  ...overrides,
});

const limit = (...plans: unknown[]) => ({ 'Node Type': 'Limit', Plans: plans });

describe('planWalksIndex', () => {
  it.each(['Index Scan', 'Index Only Scan', 'Bitmap Index Scan'])(
    'accepts a %s on the index with an Order By, anywhere in the main tree',
    (type) => {
      expect(planWalksIndex(limit(scan({ 'Node Type': type })), 'idx')).toBe(true);
      expect(
        planWalksIndex(
          limit({ 'Node Type': 'Result', Plans: [scan({ 'Node Type': type })] }),
          'idx'
        )
      ).toBe(true);
    }
  );

  it('rejects another index, with a sort, which is what a planner can choose instead', () => {
    const plan = { 'Node Type': 'Sort', Plans: [scan({ 'Index Name': 'file_chunks_pkey' })] };
    expect(planWalksIndex(plan, 'idx')).toBe(false);
  });

  it('rejects a scan of this index that has no Order By, and a sequential scan', () => {
    expect(planWalksIndex(limit(scan({ 'Order By': undefined })), 'idx')).toBe(false);
    expect(planWalksIndex(limit({ 'Node Type': 'Seq Scan', 'Relation Name': 't' }), 'idx')).toBe(
      false
    );
  });

  it.each(['InitPlan', 'SubPlan'])(
    'skips a scan under a %s: the sample subquery is not the search',
    (relationship) => {
      const inner = scan({ 'Parent Relationship': relationship });
      expect(planWalksIndex(limit(inner), 'idx')).toBe(false);
      // A child of a skipped node is skipped with it.
      expect(
        planWalksIndex(
          limit({ 'Node Type': 'Result', 'Parent Relationship': relationship, Plans: [scan()] }),
          'idx'
        )
      ).toBe(false);
    }
  );

  it.each([undefined, null, 'plan', 7, [], { Plans: 'x' }])(
    'rejects %j, which is not a plan',
    (plan) => {
      expect(planWalksIndex(plan, 'idx')).toBe(false);
    }
  );
});
