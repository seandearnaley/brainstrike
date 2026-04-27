import type { Migration } from './migration-runner';

export const migration031ProviderCatalogTimestamps: Migration = {
  version: 31,
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
  down: `
    ALTER TABLE models
      ALTER COLUMN created_at DROP DEFAULT,
      ALTER COLUMN created_at TYPE TEXT USING created_at::text,
      ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP,
      ALTER COLUMN updated_at DROP DEFAULT,
      ALTER COLUMN updated_at TYPE TEXT USING updated_at::text,
      ALTER COLUMN updated_at SET DEFAULT CURRENT_TIMESTAMP;

    ALTER TABLE providers
      ALTER COLUMN created_at DROP DEFAULT,
      ALTER COLUMN created_at TYPE TEXT USING created_at::text,
      ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP,
      ALTER COLUMN updated_at DROP DEFAULT,
      ALTER COLUMN updated_at TYPE TEXT USING updated_at::text,
      ALTER COLUMN updated_at SET DEFAULT CURRENT_TIMESTAMP;
  `,
};
