import { embeddingProfileHash } from '@brainstrike/indexer';
import { decodeIndexIdentityRow } from '@brainstrike/indexer/metadata';
import { openConnection } from '@brainstrike/sqlite-native';
import { expect, it, vi } from 'vitest';
import { fault, IndexerError } from '../src/contracts.js';
import {
  readIndexIdentity,
  readIndexSchemaVersion,
  readScopeEpoch,
} from '../src/index-metadata.js';
import { validateScopedStorage } from '../src/scoped-vector-validation.js';

it.each([readIndexIdentity, readIndexSchemaVersion, readScopeEpoch, validateScopedStorage])(
  '%s retains the exact SQL failure and inner cause without extending the fault payload',
  (read) => {
    const db = openConnection(':memory:');
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
      expect(JSON.stringify(fault(failure))).not.toMatch(/PRIVATE|cause|stack/);
    } finally {
      db.close();
    }
  }
);

it('retains a profile decoding failure through the real metadata wrapper', () => {
  const cause = new SyntaxError('Invalid profile JSON.', {
    cause: new Error('PRIVATE parser detail'),
  });
  const parse = vi.spyOn(JSON, 'parse').mockImplementationOnce(() => {
    throw cause;
  });
  try {
    let failure: unknown;
    try {
      decodeIndexIdentityRow({
        ...row,
        indexMode: 'vector-configured',
        profileHash: 'b'.repeat(64),
        profileJson: '{',
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(IndexerError);
    if (!(failure instanceof IndexerError)) {
      throw new Error('Expected IndexerError');
    }
    expect(failure.cause).toBe(cause);
    expect(fault(failure)).toEqual({
      code: 'rebuild-required',
      message:
        'Existing index metadata is invalid: Invalid profile JSON.; explicitly rebuild in a new index file.',
    });
    expect(JSON.stringify(fault(failure))).not.toContain('PRIVATE');
  } finally {
    parse.mockRestore();
  }
});

const profile = {
  dimensions: 384,
  dtype: 'fp16',
  modelId: 'onnx-community/all-MiniLM-L6-v2-ONNX',
  revision: 'aff7a1dc4e8a1ea593e6ea21e95c22ef0a25966f',
  tokenCap: 256,
} as const;
const row = {
  indexMode: 'text-only',
  profileHash: null,
  profileJson: null,
  schemaVersion: 10,
  storeId: 'a'.repeat(64),
};
it('decodes raw text and complete configured identity without a SQLite driver', () => {
  for (const schemaVersion of [8, 9, 10, 11, 12, 13, 14]) {
    expect(decodeIndexIdentityRow({ ...row, schemaVersion })).toEqual({
      embedding: { indexMode: 'text-only' },
      storeId: row.storeId,
    });
  }
  const configured = {
    ...row,
    indexMode: 'vector-configured',
    profileHash: embeddingProfileHash(profile),
    profileJson: JSON.stringify(profile),
  };
  for (const schemaVersion of [8, 9, 10, 11, 12, 13, 14]) {
    expect(decodeIndexIdentityRow({ ...configured, schemaVersion })).toEqual({
      embedding: { indexMode: 'vector-configured', profile, profileHash: configured.profileHash },
      storeId: row.storeId,
    });
  }
  for (const invalid of [
    null,
    { ...row, storeId: 'invalid' },
    { ...row, schemaVersion: 3 },
    { ...row, schemaVersion: 5 },
    { ...row, schemaVersion: 6 },
    { ...row, schemaVersion: 7 },
    { ...row, schemaVersion: 15 },
    { ...row, profileJson: '{}' },
    { ...configured, profileHash: 'b'.repeat(64) },
    { ...configured, profileJson: '{}' },
    { ...configured, profileJson: JSON.stringify({ ...profile, revision: 'latest' }) },
    { ...configured, profileHash: null },
  ]) {
    expect(() => decodeIndexIdentityRow(invalid)).toThrow('rebuild');
  }
});
