import { makeThrowingDecoder } from '@brainstrike/effect-kit';
import { describe, expect, it } from 'vitest';
import {
  classifyFindingSeverity,
  type FindingSeverity,
  INTEGRITY_CHECKS,
  type IntegrityCheck,
  MAX_FINDING_MESSAGE_LENGTH,
  type RelationFinding,
  relationFindingSchema,
  truncateFindingMessage,
} from '../src/database-integrity-finding.js';

type Durability = RelationFinding['durability'];
type Kind = RelationFinding['relationKind'];

const DURABILITIES: readonly Durability[] = [
  'precious',
  'derived',
  'operational',
  'schema-ledger',
  'catalog',
  'unclassified',
];

function severity(check: IntegrityCheck, relationKind: Kind, durability: Durability) {
  return classifyFindingSeverity({ check, durability, relationKind });
}

describe('classifyFindingSeverity', () => {
  it.each(DURABILITIES)(
    'a heap or row-count finding on a %s table is decided by what the class can rebuild',
    (durability) => {
      const expected: FindingSeverity =
        durability === 'derived' || durability === 'operational' ? 'repairable' : 'blocking';
      expect(severity('heap', 'table', durability)).toBe(expected);
      expect(severity('row-count', 'table', durability)).toBe(expected);
    }
  );

  it.each(DURABILITIES)(
    'an index finding on a %s table is repairable in a user schema and blocking in the catalog',
    (durability) => {
      // Fail closed: only an index in a user schema can be rebuilt while the database stays up.
      const expected: FindingSeverity = durability === 'catalog' ? 'blocking' : 'repairable';
      for (const check of ['btree', 'gin', 'bm25-probe', 'hnsw-probe', 'index-invalid'] as const) {
        expect(severity(check, 'index', durability), check).toBe(expected);
      }
    }
  );

  it.each(DURABILITIES)(
    'a database that would not open is blocking whatever the class (%s)',
    (durability) => {
      expect(severity('open', 'database', durability)).toBe('blocking');
    }
  );
});

describe('classifyFindingSeverity when the check and the relation kind disagree', () => {
  const HEAP_CHECKS = ['heap', 'row-count'] as const;
  const INDEX_CHECKS = ['btree', 'gin', 'bm25-probe', 'hnsw-probe', 'index-invalid'] as const;

  it.each(DURABILITIES)('fails closed for a heap check on an index (%s)', (durability) => {
    for (const check of HEAP_CHECKS) {
      expect(severity(check, 'index', durability), check).toBe('blocking');
    }
  });

  it.each(DURABILITIES)('fails closed for an index check on a table (%s)', (durability) => {
    for (const check of INDEX_CHECKS) {
      expect(severity(check, 'table', durability), check).toBe('blocking');
    }
  });

  it.each(DURABILITIES)('fails closed for any check on a whole database (%s)', (durability) => {
    for (const check of [...HEAP_CHECKS, ...INDEX_CHECKS]) {
      expect(severity(check, 'database', durability), check).toBe('blocking');
    }
  });

  it('lists every check exactly once as a heap check, an index check or open', () => {
    expect([...HEAP_CHECKS, ...INDEX_CHECKS, 'open'].sort()).toEqual([...INTEGRITY_CHECKS].sort());
  });
});

describe('truncateFindingMessage', () => {
  const decodeFinding = makeThrowingDecoder(relationFindingSchema);
  const finding = (message: string) => ({
    accessMethod: 'btree',
    check: 'btree',
    durability: 'derived',
    message,
    relation: 'idx',
    relationKind: 'index',
    sqlstate: 'XX001',
    table: 't',
  });

  it('states the limit the manifest enforces', () => {
    expect(MAX_FINDING_MESSAGE_LENGTH).toBe(240);
  });

  it('leaves a message at or under the limit untouched', () => {
    for (const length of [0, 1, MAX_FINDING_MESSAGE_LENGTH - 1, MAX_FINDING_MESSAGE_LENGTH]) {
      const message = 'x'.repeat(length);
      expect(truncateFindingMessage(message)).toBe(message);
    }
  });

  it('cuts a longer message to exactly the limit, so the schema still accepts it', () => {
    for (const length of [MAX_FINDING_MESSAGE_LENGTH + 1, 1000]) {
      const cut = truncateFindingMessage('x'.repeat(length));
      expect(cut).toHaveLength(MAX_FINDING_MESSAGE_LENGTH);
      expect(decodeFinding(finding(cut)).message).toBe(cut);
    }
    expect(() => decodeFinding(finding('x'.repeat(MAX_FINDING_MESSAGE_LENGTH + 1)))).toThrow(
      TypeError
    );
  });

  it('never leaves half of a surrogate pair at the cut', () => {
    // 239 letters and an emoji (two UTF-16 units): the limit falls between its halves.
    const cut = truncateFindingMessage(`${'a'.repeat(MAX_FINDING_MESSAGE_LENGTH - 1)}😀`);
    expect(cut).toBe('a'.repeat(MAX_FINDING_MESSAGE_LENGTH - 1));
    expect(cut.isWellFormed()).toBe(true);
  });
});
