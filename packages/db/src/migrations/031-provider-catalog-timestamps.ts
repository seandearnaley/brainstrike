import type { Migration } from './migration-runner';

export const migration031ProviderCatalogTimestamps: Migration = {
  down: `
    ALTER TABLE models
      ALTER COLUMN created_at DROP DEFAULT,
      ALTER COLUMN created_at TYPE TEXT USING to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP,
      ALTER COLUMN updated_at DROP DEFAULT,
      ALTER COLUMN updated_at TYPE TEXT USING to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      ALTER COLUMN updated_at SET DEFAULT CURRENT_TIMESTAMP;

    ALTER TABLE providers
      ALTER COLUMN created_at DROP DEFAULT,
      ALTER COLUMN created_at TYPE TEXT USING to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP,
      ALTER COLUMN updated_at DROP DEFAULT,
      ALTER COLUMN updated_at TYPE TEXT USING to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      ALTER COLUMN updated_at SET DEFAULT CURRENT_TIMESTAMP;
  `,
  ledgerKey: 'custom-031-provider-catalog-timestamps',
  name: 'provider_catalog_timestamps',
  up: `
    ALTER TABLE providers
      ALTER COLUMN created_at DROP DEFAULT,
      ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
      ALTER COLUMN created_at SET DEFAULT NOW(),
      ALTER COLUMN updated_at DROP DEFAULT,
      ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz,
      ALTER COLUMN updated_at SET DEFAULT NOW();

    ALTER TABLE models
      ALTER COLUMN created_at DROP DEFAULT,
      ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
      ALTER COLUMN created_at SET DEFAULT NOW(),
      ALTER COLUMN updated_at DROP DEFAULT,
      ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz,
      ALTER COLUMN updated_at SET DEFAULT NOW();
  `,
  version: 31,
};
