import { describe, expect, it } from 'vitest';
import {
  classifyFindingSeverity,
  type FindingSeverity,
  type IntegrityCheck,
  type RelationFinding,
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
      for (const check of ['btree', 'gin', 'bm25-probe', 'hnsw-probe'] as const) {
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
