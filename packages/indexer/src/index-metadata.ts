import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { Schema } from 'effect';
import {
  decoder,
  IndexerError,
  type IndexerIdentity,
  type IndexerOptions,
  scopedProofIdentitySchema,
} from './contracts.ts';

export const INDEX_SCHEMA_VERSION = 16;
/** Derived data is rebuildable (ADR-0020): any other stored version refuses as rebuild-required. */
const supportedSchemaVersion = Schema.Literal(INDEX_SCHEMA_VERSION);
const metadataSchema = Schema.Struct({
  schemaVersion: supportedSchemaVersion,
  storeId: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
});
export function freshIdentity(options: IndexerOptions): IndexerIdentity {
  if (options.embedding.indexMode === 'open-existing') {
    throw new IndexerError(
      'index-not-found',
      'Explicit open-existing requires an existing index file.'
    );
  }
  return { storeId: randomBytes(32).toString('hex') };
}
/** Driver-neutral row boundary; the supplied metadata must come from the caller's owned snapshot. */
export function decodeIndexIdentityRow(input: unknown): IndexerIdentity {
  try {
    return { storeId: decoder(metadataSchema)(input).storeId };
  } catch (error) {
    throw new IndexerError(
      'rebuild-required',
      `Existing index metadata is invalid: ${error instanceof Error ? error.message : String(error)}; explicitly rebuild in a new index file.`,
      { cause: error }
    );
  }
}
/** Refuses any stored schema but the current one; opening never upgrades or deletes it. */
export function readIndexSchemaVersion(db: Database.Database): typeof INDEX_SCHEMA_VERSION {
  try {
    return decoder(supportedSchemaVersion)(
      db.prepare('SELECT schema_version FROM index_metadata WHERE singleton=1').pluck().get()
    );
  } catch (error) {
    throw new IndexerError(
      'rebuild-required',
      `Unsupported derived schema: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}
export function readIndexIdentity(db: Database.Database): IndexerIdentity {
  try {
    return decodeIndexIdentityRow(
      db
        .prepare(
          'SELECT schema_version AS schemaVersion,store_id AS storeId FROM index_metadata WHERE singleton=1'
        )
        .get()
    );
  } catch (error) {
    if (error instanceof IndexerError) {
      throw error;
    }
    throw new IndexerError(
      'rebuild-required',
      `Existing index metadata cannot be read: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
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
      `Stored scope authority is invalid: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
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
