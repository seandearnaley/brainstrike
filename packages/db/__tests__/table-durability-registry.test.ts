import { describe, expect, it } from 'vitest';
import {
  buildTableDurabilityIndex,
  getTableDurability,
  TABLE_DURABILITY_REGISTRY,
} from '../src/table-durability-registry';

describe('getTableDurability', () => {
  it.each([
    ['mastra_messages', 'precious'],
    ['file_chunks', 'derived'],
    ['job_queue', 'operational'],
    ['__drizzle_migrations', 'schema-ledger'],
  ] as const)('returns the class of %s', (table, expected) => {
    expect(getTableDurability(table)).toBe(expected);
  });

  it('throws a descriptive error for an unregistered table instead of guessing', () => {
    expect(() => getTableDurability('not_a_real_table')).toThrow(
      /Table "not_a_real_table" has no durability class.*table-durability-registry\.ts/u
    );
  });
});

describe('TABLE_DURABILITY_REGISTRY shape', () => {
  it('names a rebuild owner exactly on derived entries', () => {
    for (const entry of TABLE_DURABILITY_REGISTRY) {
      expect(entry.rebuildOwner !== undefined, entry.table).toBe(entry.durability === 'derived');
      if (entry.rebuildOwner !== undefined) {
        expect(entry.rebuildOwner, entry.table).toMatch(/^[\w./-]+\.tsx?#\w+$/u);
      }
    }
  });

  it('gives every entry a one-line reason', () => {
    for (const entry of TABLE_DURABILITY_REGISTRY) {
      expect(entry.reason.trim().length, entry.table).toBeGreaterThan(0);
      expect(entry.reason, entry.table).not.toContain('\n');
    }
  });
});

describe('buildTableDurabilityIndex', () => {
  const entry = (table: string, durability: 'precious' | 'operational') =>
    ({ durability, reason: 'r', table }) as const;

  it('maps each table to its class', () => {
    const index = buildTableDurabilityIndex([entry('a', 'precious'), entry('b', 'operational')]);
    expect([index.get('a'), index.get('b')]).toEqual(['precious', 'operational']);
  });

  it('throws when a table is classified twice, even with the same class', () => {
    expect(() =>
      buildTableDurabilityIndex([entry('dup', 'precious'), entry('dup', 'precious')])
    ).toThrow('Table "dup" is classified more than once');
  });
});
