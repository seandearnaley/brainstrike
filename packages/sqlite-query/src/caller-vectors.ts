import type { DatabaseSync } from 'node:sqlite';
import { makeThrowingDecoder } from '@brainstrike/effect-kit';
import { vectorProfileHash } from '@brainstrike/indexer';
import { decodeIndexIdentityRow } from '@brainstrike/indexer/metadata';
import { Schema } from 'effect';
import type { SqliteQueryRequirement, SqliteValue } from './protocol.js';

const decodeCount = makeThrowingDecoder(Schema.Struct({ count: Schema.Int }));
const decodeProfile = makeThrowingDecoder(
  Schema.Struct({
    dimensions: Schema.Int,
    distance: Schema.Literal('cosine'),
  })
);
const decodeRegistered = makeThrowingDecoder(Schema.Struct({ profileJson: Schema.String }));
const decodeChunk = makeThrowingDecoder(
  Schema.Struct({
    contentHash: Schema.String,
    dimensions: Schema.NullOr(Schema.Int),
    emb: Schema.NullOr(Schema.Uint8Array),
    vectorContentHash: Schema.NullOr(Schema.String),
  })
);
export const CALLER_BINDING_NAMES = [
  '$brainstrike_collection',
  '$brainstrike_profile',
  '$brainstrike_files',
] as const;
const AUTHORIZED_FILES =
  'SELECT id FROM file_records WHERE scoped=1 AND embedding_set_id=? AND id IN (SELECT value FROM json_each(?))';
const CALLER_SCOPE = `WITH RECURSIVE authorized_files AS (${AUTHORIZED_FILES}), callers(file_record_id,seq,name,depth) AS (
  SELECT s.file_record_id,s.seq,s.name,0 FROM file_symbols s JOIN authorized_files a ON a.id=s.file_record_id WHERE s.name=?
  UNION
  SELECT enclosing.file_record_id,enclosing.seq,enclosing.name,c.depth+1
  FROM callers c JOIN file_symbol_refs r ON r.name=c.name AND r.kind='call'
  JOIN file_symbols enclosing ON enclosing.file_record_id=r.file_record_id AND enclosing.seq=r.from_symbol_seq
  JOIN authorized_files a ON a.id=enclosing.file_record_id WHERE c.depth<10
), reachable AS (SELECT DISTINCT file_record_id FROM callers)`;

/** Validates the exact main-authorized profile and every graph chunk in the owned snapshot. */
export function requireCallerVectors(
  database: DatabaseSync,
  requirement: SqliteQueryRequirement
): Readonly<Record<string, SqliteValue>> {
  const context = requirement.context;
  if (
    !context ||
    context.fileIds.length === 0 ||
    new Set(context.fileIds).size !== context.fileIds.length
  ) {
    throw new TypeError(
      'Caller-vector lens requires an explicit current collection and complete vector profile.'
    );
  }
  const identity = decodeIndexIdentityRow(
    database
      .prepare(
        'SELECT schema_version AS schemaVersion,store_id AS storeId,index_mode AS indexMode,profile_json AS profileJson,profile_hash AS profileHash FROM index_metadata WHERE singleton=1'
      )
      .get()
  );
  if (identity.storeId !== context.storeId) {
    throw new TypeError('Caller-vector lens store identity differs from current main authority.');
  }
  const profileHash = vectorProfileHash(context.profile);
  const registered = database
    .prepare('SELECT profile_json AS profileJson FROM vector_profiles WHERE profile_hash=?')
    .get(profileHash);
  if (!registered) {
    throw new TypeError('Caller-vector lens profile does not match the stored scoped profile.');
  }
  const storedProfile: unknown = JSON.parse(decodeRegistered(registered).profileJson);
  if (vectorProfileHash(storedProfile) !== profileHash) {
    throw new TypeError('Caller-vector lens stored profile identity is invalid.');
  }
  const profile = decodeProfile(storedProfile);
  const files = JSON.stringify(context.fileIds);
  const scopeValues = [context.collectionId, files, requirement.symbol];
  if (
    decodeCount(
      database
        .prepare(`SELECT count(*) AS count FROM (${AUTHORIZED_FILES})`)
        .get(context.collectionId, files)
    ).count !== context.fileIds.length
  ) {
    throw new TypeError(
      'Caller-vector lens canonical collection membership is incomplete or changed.'
    );
  }
  if (
    decodeCount(
      database
        .prepare(
          `SELECT count(*) AS count FROM file_symbols s JOIN (${AUTHORIZED_FILES}) a ON a.id=s.file_record_id WHERE s.name=?`
        )
        .get(...scopeValues)
    ).count === 0
  ) {
    throw new TypeError(
      'Caller-vector lens requires an existing seed symbol in the authorized collection.'
    );
  }
  const rows = database.prepare(`${CALLER_SCOPE}
    SELECT ch.content_hash AS contentHash,v.content_hash AS vectorContentHash,v.dimensions,v.emb
    FROM file_chunks ch JOIN reachable rf ON rf.file_record_id=ch.file_record_id
    LEFT JOIN scoped_vectors v ON v.chunk_pk=ch.pk AND v.profile_hash=?`);
  let chunks = 0;
  for (const raw of rows.iterate(...scopeValues, profileHash)) {
    const row = decodeChunk(raw);
    if (
      row.vectorContentHash !== row.contentHash ||
      row.dimensions !== profile.dimensions ||
      row.emb === null
    ) {
      throw new TypeError(
        'Caller-vector lens requires complete vectors with the current scoped profile for every graph-scoped chunk.'
      );
    }
    requireFiniteVector(row.emb, profile.dimensions);
    chunks += 1;
  }
  if (
    chunks === 0 ||
    decodeCount(
      database
        .prepare(
          `SELECT count(*) AS count FROM file_chunks ch JOIN file_symbols s ON s.file_record_id=ch.file_record_id JOIN (${AUTHORIZED_FILES}) a ON a.id=s.file_record_id JOIN scoped_vectors v ON v.chunk_pk=ch.pk AND v.profile_hash=? WHERE s.name=? AND ch.start_line<=s.start_line AND ch.end_line>=s.start_line`
        )
        .get(context.collectionId, files, profileHash, requirement.symbol)
    ).count === 0
  ) {
    throw new TypeError(
      'Caller-vector lens requires a vector-bearing source chunk containing the seed symbol.'
    );
  }
  return {
    ['$brainstrike_collection']: context.collectionId,
    ['$brainstrike_files']: files,
    ['$brainstrike_profile']: profileHash,
  };
}

function requireFiniteVector(bytes: Uint8Array, dimensions: number): void {
  if (bytes.byteLength !== dimensions * 4) {
    throw new TypeError(
      'Caller-vector lens requires complete vectors of the configured dimension.'
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let norm = 0;
  for (let index = 0; index < dimensions; index += 1) {
    const value = view.getFloat32(index * 4, true);
    if (!Number.isFinite(value)) {
      throw new TypeError('Caller-vector lens requires finite vector components.');
    }
    norm += value * value;
  }
  if (norm === 0) {
    throw new TypeError('Caller-vector lens requires nonzero vectors for cosine distance.');
  }
}
