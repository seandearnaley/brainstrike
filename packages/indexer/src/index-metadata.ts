import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { Schema } from 'effect';
import { embeddingProfileHash, sha256 } from './chunks.js';
import {
  decoder,
  type EmbeddingState,
  IndexerError,
  type IndexerIdentity,
  type IndexerOptions,
  profileSchema,
  scopedProofIdentitySchema,
} from './contracts.js';

export const INDEX_SCHEMA_VERSION = 9;
const metadataSchema = Schema.Struct({
  indexMode: Schema.Literals(['text-only', 'vector-configured']),
  profileHash: Schema.NullOr(Schema.String),
  profileJson: Schema.NullOr(Schema.String),
  schemaVersion: Schema.Int,
  storeId: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
});
export function configuredEmbedding(
  input: unknown
): EmbeddingState & { indexMode: 'vector-configured' } {
  const profile = decoder(profileSchema)(input);
  if (profile.dimensions !== 384) {
    throw new IndexerError(
      'unsupported-profile',
      'This index schema supports qualified 384-dimension profiles only.'
    );
  }
  return { indexMode: 'vector-configured', profile, profileHash: embeddingProfileHash(profile) };
}
export function freshIdentity(options: IndexerOptions): IndexerIdentity {
  if (options.embedding.indexMode === 'open-existing') {
    throw new IndexerError(
      'index-not-found',
      'Explicit open-existing requires an existing index file.'
    );
  }
  return {
    embedding:
      options.embedding.indexMode === 'text-only'
        ? { indexMode: 'text-only' }
        : configuredEmbedding(options.embedding.profile),
    storeId: randomBytes(32).toString('hex'),
  };
}
/** Driver-neutral row boundary; the supplied metadata must come from the caller's owned snapshot. */
export function decodeIndexIdentityRow(input: unknown): IndexerIdentity {
  try {
    const row = decoder(metadataSchema)(input);
    if (row.schemaVersion !== INDEX_SCHEMA_VERSION) {
      throw new Error('Derived schema changed.');
    }
    if (row.indexMode === 'text-only') {
      if (row.profileJson !== null || row.profileHash !== null) {
        throw new Error('Text identity has unexpected vector metadata.');
      }
      return { embedding: { indexMode: 'text-only' }, storeId: row.storeId };
    }
    if (row.profileJson === null || row.profileHash === null) {
      throw new Error('Configured identity has no complete vector metadata.');
    }
    const embedding = configuredEmbedding(JSON.parse(row.profileJson));
    if (row.profileHash !== embedding.profileHash) {
      throw new Error('Stored vector profile hash disagrees.');
    }
    return { embedding, storeId: row.storeId };
  } catch (error) {
    throw new IndexerError(
      'rebuild-required',
      `Existing index metadata is invalid: ${error instanceof Error ? error.message : String(error)}; explicitly rebuild in a new index file.`
    );
  }
}
export function readIndexIdentity(db: Database.Database): IndexerIdentity {
  try {
    return decodeIndexIdentityRow(
      db
        .prepare(
          'SELECT schema_version AS schemaVersion,store_id AS storeId,index_mode AS indexMode,profile_json AS profileJson,profile_hash AS profileHash FROM index_metadata WHERE singleton=1'
        )
        .get()
    );
  } catch (error) {
    if (error instanceof IndexerError) {
      throw error;
    }
    throw new IndexerError(
      'rebuild-required',
      `Existing index metadata cannot be read: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
export function readScopeEpoch(db: Database.Database): string {
  try {
    return decoder(scopedProofIdentitySchema.fields.authorityEpoch)(
      db.prepare('SELECT epoch FROM index_scope_authority WHERE singleton=1').pluck().get()
    );
  } catch (error) {
    throw new IndexerError(
      'rebuild-required',
      `Stored scope authority is invalid: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
export function readScopedIdentity(
  db: Database.Database,
  authorityRevision: number
): typeof scopedProofIdentitySchema.Type {
  return decoder(scopedProofIdentitySchema)({
    authorityEpoch: readScopeEpoch(db),
    authorityRevision,
    storeId: readIndexIdentity(db).storeId,
  });
}
export function validateAcquisition(
  db: Database.Database,
  options: IndexerOptions
): IndexerIdentity {
  const identity = readIndexIdentity(db);
  if (options.embedding.indexMode === 'open-existing') {
    return identity;
  }
  const requested =
    options.embedding.indexMode === 'text-only'
      ? { indexMode: 'text-only' }
      : {
          indexMode: 'vector-configured',
          profile: options.embedding.profile,
          profileHash: embeddingProfileHash(options.embedding.profile),
        };
  if (JSON.stringify(requested) !== JSON.stringify(identity.embedding)) {
    throw new IndexerError(
      'rebuild-required',
      'Requested embedding state differs from the stored index; explicitly reopen its stored identity or rebuild in a new file.'
    );
  }
  return identity;
}
/** Checks persisted chunk/profile identity; never infers vector presence from total counts. */
export function validateChunkEmbeddingState(
  db: Database.Database,
  identity: IndexerIdentity,
  rootIds?: readonly string[]
): void {
  if (rootIds?.length === 0) {
    return;
  }
  const predicate = rootIds ? ` AND c.root_id IN (${rootIds.map(() => '?').join(',')})` : '';
  const rows = decoder(
    Schema.Array(
      Schema.Struct({
        contentHash: Schema.String,
        embeddingHash: Schema.NullOr(Schema.String),
        hasVector: Schema.Literals([0, 1]),
      })
    )
  )(
    db
      .prepare(
        `SELECT c.content_hash AS contentHash,c.embedding_hash AS embeddingHash,c.has_vector AS hasVector FROM file_chunks c JOIN file_records f ON f.id=c.file_record_id WHERE f.scoped=0${predicate}`
      )
      .all(...(rootIds ?? []))
  );
  for (const row of rows) {
    const expected =
      identity.embedding.indexMode === 'vector-configured'
        ? sha256(JSON.stringify([identity.embedding.profileHash, row.contentHash]))
        : null;
    if (
      row.embeddingHash !== expected ||
      (identity.embedding.indexMode === 'text-only' && row.hasVector !== 0)
    ) {
      throw new IndexerError(
        'rebuild-required',
        'Stored chunk embedding identity disagrees with its explicit store state.'
      );
    }
  }
}
