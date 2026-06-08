import type { Migration } from './migration-runner';

/**
 * Migration 035: UUIDv7 primary-key defaults
 *
 * Switches the DB-default UUID primary keys from gen_random_uuid() (UUIDv4,
 * random) to uuidv7() (Postgres 18). UUIDv7 embeds a millisecond timestamp, so
 * keys are time-sortable — improving B-tree insert locality and giving natural
 * chronological ordering for keyset pagination.
 *
 * Applies to the tables whose ids come from the column default. Tables that
 * generate ids in application code are unaffected by the default and keep their
 * existing behavior.
 *
 * `ALTER TABLE IF EXISTS` keeps this safe across both migration runners: the
 * drizzle (production) path has all four tables from the manifest, while the
 * legacy numbered runner may not create every one of them.
 */
export const migration035Uuidv7PrimaryKeys: Migration = {
  version: 35,
  name: 'uuidv7_primary_keys',
  up: `
    ALTER TABLE IF EXISTS selection_snapshots ALTER COLUMN id SET DEFAULT uuidv7();
    ALTER TABLE IF EXISTS token_cache ALTER COLUMN id SET DEFAULT uuidv7();
    ALTER TABLE IF EXISTS embedding_cache ALTER COLUMN id SET DEFAULT uuidv7();
    ALTER TABLE IF EXISTS view_filter_presets ALTER COLUMN id SET DEFAULT uuidv7();
  `,
  down: `
    ALTER TABLE IF EXISTS selection_snapshots ALTER COLUMN id SET DEFAULT gen_random_uuid();
    ALTER TABLE IF EXISTS token_cache ALTER COLUMN id SET DEFAULT gen_random_uuid();
    ALTER TABLE IF EXISTS embedding_cache ALTER COLUMN id SET DEFAULT gen_random_uuid();
    ALTER TABLE IF EXISTS view_filter_presets ALTER COLUMN id SET DEFAULT gen_random_uuid();
  `,
};
