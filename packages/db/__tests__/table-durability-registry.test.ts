import { describe, expect, it } from 'vitest';
import {
  buildTableDurabilityIndex,
  findTableDurability,
  getTableDurability,
  TABLE_DURABILITY_CLASSES,
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

describe('findTableDurability', () => {
  it('returns the class of a registered table and undefined for an unregistered one', () => {
    expect(findTableDurability('mastra_messages')).toBe('precious');
    expect(findTableDurability('not_a_real_table')).toBeUndefined();
  });
});

describe('TABLE_DURABILITY_CLASSES', () => {
  it('lists every class a registry entry uses, and no other', () => {
    const used = new Set(TABLE_DURABILITY_REGISTRY.map((entry) => entry.durability));
    expect([...TABLE_DURABILITY_CLASSES].sort()).toEqual([...used].sort());
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

  it('discloses the managed-collection-only rebuild on every table the workspace import rebuilds', () => {
    // Repair surfaces `reason` per truncated table, so the limit cannot live
    // only on the cascade root (`file_records`).
    const importRebuilt = TABLE_DURABILITY_REGISTRY.filter((entry) =>
      entry.rebuildOwner?.endsWith('#runRootFolderCacheImport')
    );
    expect(importRebuilt.map((entry) => entry.table)).toEqual(
      expect.arrayContaining(['file_chunks', 'file_records', 'file_symbol_refs', 'file_symbols'])
    );
    for (const entry of importRebuilt) {
      expect(entry.reason, entry.table).toContain('manual imports need a re-import');
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
