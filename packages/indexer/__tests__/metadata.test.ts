import { embeddingProfileHash } from '@brainstrike/indexer';
import { decodeIndexIdentityRow } from '@brainstrike/indexer/metadata';
import { expect, it } from 'vitest';

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
  schemaVersion: 8,
  storeId: 'a'.repeat(64),
};
it('decodes raw text and complete configured identity without a SQLite driver', () => {
  expect(decodeIndexIdentityRow(row)).toEqual({
    embedding: { indexMode: 'text-only' },
    storeId: row.storeId,
  });
  const configured = {
    ...row,
    indexMode: 'vector-configured',
    profileHash: embeddingProfileHash(profile),
    profileJson: JSON.stringify(profile),
  };
  expect(decodeIndexIdentityRow(configured)).toEqual({
    embedding: { indexMode: 'vector-configured', profile, profileHash: configured.profileHash },
    storeId: row.storeId,
  });
  for (const invalid of [
    null,
    { ...row, storeId: 'invalid' },
    { ...row, schemaVersion: 3 },
    { ...row, schemaVersion: 5 },
    { ...row, schemaVersion: 6 },
    { ...row, schemaVersion: 7 },
    { ...row, profileJson: '{}' },
    { ...configured, profileHash: 'b'.repeat(64) },
    { ...configured, profileJson: '{}' },
    { ...configured, profileJson: JSON.stringify({ ...profile, revision: 'latest' }) },
    { ...configured, profileHash: null },
  ]) {
    expect(() => decodeIndexIdentityRow(invalid)).toThrow('rebuild');
  }
});
