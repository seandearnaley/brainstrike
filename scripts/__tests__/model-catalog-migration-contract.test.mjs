import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { analyzeModelCatalogMigrationContract } from '../model-catalog-migration-contract.mjs';

const migrationIndexSource = `
import { migration025UpdateProviderModels2026 } from './025-update-provider-models-2026.js';
import { migration031ProviderCatalogTimestamps } from './031-provider-catalog-timestamps.js';

export const migrations = [
  migration025UpdateProviderModels2026,
  migration031ProviderCatalogTimestamps,
];
`;

function migrationFile(file, exportName, body) {
  return {
    file,
    source: `
import type { Migration } from './migration-runner';

export const ${exportName}: Migration = {
  version: 25,
  name: 'fixture',
  up: \`
    ${body}
  \`,
  down: \`\`,
};
`,
  };
}

describe('model catalog migration contract', () => {
  it('requires catalog-mutating migrations to be registered in the app custom ledger', () => {
    const result = analyzeModelCatalogMigrationContract({
      drizzleMigrateSource: `
const customMigrations = [
];
`,
      migrationFiles: [
        migrationFile(
          'packages/db/src/migrations/025-update-provider-models-2026.ts',
          'migration025UpdateProviderModels2026',
          "INSERT INTO models (id, provider_id) VALUES ('gpt-next', 'openai');"
        ),
      ],
      migrationIndexSource,
    });

    assert.deepEqual(result.failures, [
      {
        file: 'packages/db/src/migrations/025-update-provider-models-2026.ts',
        message:
          'Catalog-mutating migration migration025UpdateProviderModels2026 is missing from packages/db/src/drizzle/migrate.ts customMigrations.',
      },
    ]);
  });

  it('fails closed when a catalog-mutating migration has no recognizable export declaration', () => {
    const result = analyzeModelCatalogMigrationContract({
      drizzleMigrateSource: `
const customMigrations = [];
`,
      migrationFiles: [
        {
          file: 'packages/db/src/migrations/039-catalog-refresh.ts',
          source: `
import type { Migration } from './migration-runner';

export const migration039CatalogRefresh = {
  version: 39,
  name: 'catalog refresh',
  up: \`
    UPDATE models SET label = 'GPT Next' WHERE id = 'gpt-next';
  \`,
  down: \`\`,
} satisfies Migration;
`,
        },
      ],
      migrationIndexSource,
    });

    assert.deepEqual(result.failures, [
      {
        file: 'packages/db/src/migrations/039-catalog-refresh.ts',
        message:
          'Catalog-mutating migration in packages/db/src/migrations/039-catalog-refresh.ts has no recognizable `export const migrationNNN: Migration =` declaration; the contract checker cannot verify its registration.',
      },
    ]);
  });

  it('allows catalog schema migrations that do not mutate catalog rows', () => {
    const result = analyzeModelCatalogMigrationContract({
      drizzleMigrateSource: `
const customMigrations = [
];
`,
      migrationFiles: [
        migrationFile(
          'packages/db/src/migrations/031-provider-catalog-timestamps.ts',
          'migration031ProviderCatalogTimestamps',
          'ALTER TABLE models ALTER COLUMN updated_at SET DEFAULT now();'
        ),
      ],
      migrationIndexSource,
    });

    assert.deepEqual(result.failures, []);
  });

  it('requires custom migrations to stay registered in the numbered migration runner', () => {
    const result = analyzeModelCatalogMigrationContract({
      drizzleMigrateSource: `
const customMigrations = [
  customMigration('custom-025-update-provider-models-2026', migration025UpdateProviderModels2026),
];
`,
      migrationFiles: [
        migrationFile(
          'packages/db/src/migrations/025-update-provider-models-2026.ts',
          'migration025UpdateProviderModels2026',
          "DELETE FROM models WHERE provider_id = 'openai';"
        ),
      ],
      migrationIndexSource: `
export const migrations = [];
`,
    });

    assert.deepEqual(result.failures, [
      {
        file: 'packages/db/src/migrations/025-update-provider-models-2026.ts',
        message:
          'Catalog-mutating migration migration025UpdateProviderModels2026 is missing from packages/db/src/migrations/index.ts migrations.',
      },
      {
        file: 'packages/db/src/drizzle/migrate.ts',
        message:
          'Custom migration migration025UpdateProviderModels2026 is missing from packages/db/src/migrations/index.ts migrations.',
      },
    ]);
  });

  it('requires preference remaps for removed assistant model IDs', () => {
    const result = analyzeModelCatalogMigrationContract({
      assistantPreferencesSource: `
const MODEL_ID_MIGRATIONS: Record<SupportedProvider, Record<string, string>> = {
  openrouter: {},
};
`,
      drizzleMigrateSource: `
const customMigrations = [
  customMigration('custom-032-previous-catalog', migration032PreviousCatalog),
  customMigration('custom-033-update-provider-models-2026-frontier', migration033UpdateProviderModels2026Frontier),
];
`,
      memoryPreferencesSource: `
const MEMORY_MODEL_TARGET_MIGRATIONS: Record<string, string> = {};
`,
      migrationFiles: [
        migrationFile(
          'packages/db/src/migrations/032-previous-catalog.ts',
          'migration032PreviousCatalog',
          `
            INSERT INTO models (id, provider_id, name, capabilities) VALUES
              ('anthropic/claude-sonnet-4.5', 'openrouter', 'Claude Sonnet 4.5', '{"type":"llm","streaming":true}');
          `
        ),
        migrationFile(
          'packages/db/src/migrations/033-update-provider-models-2026-frontier.ts',
          'migration033UpdateProviderModels2026Frontier',
          `
            DELETE FROM models WHERE id IN ('anthropic/claude-sonnet-4.5');
            INSERT INTO models (id, provider_id, name, capabilities) VALUES
              ('anthropic/claude-sonnet-4.6', 'openrouter', 'Claude Sonnet 4.6', '{"type":"llm","streaming":true}');
          `
        ),
      ],
      migrationIndexSource: `
export const migrations = [
  migration032PreviousCatalog,
  migration033UpdateProviderModels2026Frontier,
];
`,
    });

    assert.deepEqual(result.failures, [
      {
        file: 'packages/preferences/src/stores/assistant-preferences-store.ts',
        message:
          'Removed assistant catalog model openrouter::anthropic/claude-sonnet-4.5 is missing from MODEL_ID_MIGRATIONS.',
      },
      {
        file: 'packages/preferences/src/stores/assistant-memory-preferences-store.ts',
        message:
          'Removed assistant memory model target openrouter/anthropic/claude-sonnet-4.5 is missing from MEMORY_MODEL_TARGET_MIGRATIONS.',
      },
    ]);
  });
});
