import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { fault, IndexerError } from '../src/contracts.js';
import {
  decodeIndexIdentityRow,
  readIndexIdentity,
  readIndexSchemaVersion,
} from '../src/index-metadata.js';

it.each([readIndexIdentity, readIndexSchemaVersion])(
  '%s retains the exact SQL failure and inner cause without extending the fault payload',
  (read) => {
    const db = new Database(':memory:');
    const inner = new Error('PRIVATE driver detail');
    const cause = new Error('Metadata read failed.', { cause: inner });
    vi.spyOn(db, 'prepare').mockImplementation(() => {
      throw cause;
    });
    try {
      let failure: unknown;
      try {
        read(db);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(IndexerError);
      if (!(failure instanceof IndexerError)) {
        throw new Error('Expected IndexerError');
      }
      expect(failure.cause).toBe(cause);
      expect(cause.cause).toBe(inner);
      expect(failure.code).toBe('rebuild-required');
      expect(Object.getOwnPropertyDescriptor(failure, 'cause')?.enumerable).toBe(false);
      expect(fault(failure)).toEqual({ code: 'rebuild-required', message: failure.message });
      expect(JSON.stringify(fault(failure))).not.toMatch(/PRIVATE|cause|stack/u);
    } finally {
      db.close();
    }
  }
);

const row = {
  schemaVersion: 17,
  storeId: 'a'.repeat(64),
};
it('decodes raw store identity without a SQLite driver', () => {
  expect(decodeIndexIdentityRow(row)).toEqual({ storeId: row.storeId });
  for (const invalid of [
    null,
    { ...row, storeId: 'invalid' },
    ...[3, 8, 16, 18].map((schemaVersion) => ({ ...row, schemaVersion })),
  ]) {
    expect(() => decodeIndexIdentityRow(invalid)).toThrow('rebuild');
  }
});
