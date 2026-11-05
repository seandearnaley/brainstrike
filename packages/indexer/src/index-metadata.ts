import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { Schema } from 'effect';
import { decoder, IndexerError, type IndexerIdentity } from './contracts.ts';

/** 17: the workspace file, chunk, symbol and vector tables are gone (BST-2436). */
export const INDEX_SCHEMA_VERSION = 17;
/** Derived data is rebuildable (ADR-0020): any other stored version refuses as rebuild-required. */
const supportedSchemaVersion = Schema.Literal(INDEX_SCHEMA_VERSION);
const metadataSchema = Schema.Struct({
  schemaVersion: supportedSchemaVersion,
  storeId: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
});
export function freshIdentity(): IndexerIdentity {
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
