import type Database from 'better-sqlite3';
import { Schema } from 'effect';
import { decoder, IndexerError, vectorProfileSchema } from './contracts.js';
import { supportedVectorProfile, vectorProfileHash } from './scope-authority.js';

const integer = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
);
export function vectorTable(dimensions: number): string {
  decoder(integer.check(Schema.isLessThanOrEqualTo(16_000)))(dimensions);
  return `scope_vec_${dimensions}`;
}
/** Padding belongs only to the coarse sign index; retained vectors keep their exact dimensions. */
export function coarseVectorBlob(embedding: Uint8Array): Uint8Array {
  const padded = new Uint8Array(Math.ceil(embedding.byteLength / 32) * 32);
  padded.set(embedding);
  return padded;
}

export function validateScopedStorage(db: Database.Database, profileHash?: string): void {
  try {
    const invalidChunks = decoder(Schema.Int)(
      db
        .prepare(
          'SELECT count(*) FROM file_chunks c JOIN file_records f ON f.id=c.file_record_id WHERE c.root_id IS NOT f.root_id OR (f.scoped=1 AND (c.has_vector!=0 OR c.embedding_hash IS NOT NULL))'
        )
        .pluck()
        .get()
    );
    if (invalidChunks !== 0) {
      throw new Error('Canonical chunk/root/scoped vector metadata disagree.');
    }
    validateVectorBytes(db, profileHash);
    const profiles = decoder(
      Schema.Array(Schema.Struct({ dimensions: integer, hash: Schema.String, json: Schema.String }))
    )(
      db
        .prepare(
          `SELECT profile_hash AS hash,profile_json AS json,dimensions FROM vector_profiles${profileHash ? ' WHERE profile_hash=?' : ''}`
        )
        .all(...(profileHash ? [profileHash] : []))
    );
    for (const row of profiles) {
      const profile = decoder(vectorProfileSchema)(JSON.parse(row.json));
      supportedVectorProfile(profile);
      if (row.hash !== vectorProfileHash(profile) || row.dimensions !== profile.dimensions) {
        throw new Error('Profile hash/dimensions disagree.');
      }
    }
    const bad = decoder(Schema.Int)(
      db
        .prepare(
          'SELECT count(*) FROM scoped_vectors v LEFT JOIN file_chunks c ON c.pk=v.chunk_pk LEFT JOIN vector_profiles p ON p.profile_hash=v.profile_hash WHERE c.pk IS NULL OR p.profile_hash IS NULL OR v.content_hash!=c.content_hash OR v.dimensions!=p.dimensions OR length(v.emb)!=v.dimensions*4'
        )
        .pluck()
        .get()
    );
    if (bad !== 0) {
      throw new Error('Scoped vector ownership/content/dimensions disagree.');
    }
    for (const dimensions of new Set(profiles.map((row) => row.dimensions))) {
      validateCoarseRows(db, dimensions, profileHash);
    }
  } catch (error) {
    throw new IndexerError(
      'rebuild-required',
      `Scoped profile/vector storage is invalid: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function validateVectorBytes(db: Database.Database, profileHash?: string): void {
  for (const input of db
    .prepare(
      `SELECT dimensions,emb FROM scoped_vectors${profileHash ? ' WHERE profile_hash=?' : ''}`
    )
    .iterate(...(profileHash ? [profileHash] : []))) {
    validateStoredVectorBytes(input);
  }
}

export function validateStoredVectorBytes(input: unknown): void {
  const row = decoder(Schema.Struct({ dimensions: integer, emb: Schema.Uint8Array }))(input);
  if (row.emb.byteLength !== row.dimensions * 4) {
    throw new Error('Stored Float32 vector dimensions disagree.');
  }
  const emb = new DataView(row.emb.buffer, row.emb.byteOffset, row.emb.byteLength);
  let nonzero = false;
  for (let offset = 0; offset < row.emb.byteLength; offset += 4) {
    const value = emb.getFloat32(offset, true);
    if (!Number.isFinite(value)) {
      throw new TypeError('Embedding must remain finite and nonzero as float32.');
    }
    if (value !== 0) {
      nonzero = true;
    }
  }
  if (!nonzero) {
    throw new TypeError('Embedding must remain finite and nonzero as float32.');
  }
}

function validateCoarseRows(db: Database.Database, dimensions: number, profileHash?: string): void {
  const table = vectorTable(dimensions);
  const mismatch = decoder(Schema.Int)(
    db
      .prepare(
        `SELECT count(*) FROM scoped_vectors v LEFT JOIN ${table} b ON b.id=v.pk WHERE v.dimensions=?${profileHash ? ' AND v.profile_hash=?' : ''} AND (b.id IS NULL OR b.profile_hash!=v.profile_hash OR b.bin!=vec_quantize_binary(CAST(v.emb||zeroblob(${(Math.ceil(dimensions / 8) * 8 - dimensions) * 4}) AS BLOB)))`
      )
      .pluck()
      .get(dimensions, ...(profileHash ? [profileHash] : []))
  );
  const orphan = decoder(Schema.Int)(
    db
      .prepare(
        `SELECT count(*) FROM ${table} b LEFT JOIN scoped_vectors v ON v.pk=b.id WHERE ${profileHash ? 'b.profile_hash=? AND ' : ''}(v.pk IS NULL OR v.dimensions!=? OR v.profile_hash!=b.profile_hash)`
      )
      .pluck()
      .get(...(profileHash ? [profileHash] : []), dimensions)
  );
  if (mismatch !== 0 || orphan !== 0) {
    throw new Error('Scoped coarse vector rows disagree.');
  }
}
