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

  it('checks every assistant model delete migration for preference remaps', () => {
    const result = analyzeModelCatalogMigrationContract({
      assistantPreferencesSource: `
const MODEL_ID_MIGRATIONS: Record<SupportedProvider, Record<string, string>> = {
  openrouter: {
    'anthropic/claude-sonnet-4.6': 'anthropic/claude-sonnet-4.7',
  },
};
`,
      drizzleMigrateSource: `
const customMigrations = [
  customMigration('custom-032-previous-catalog', migration032PreviousCatalog),
  customMigration('custom-033-frontier-catalog', migration033FrontierCatalog),
  customMigration('custom-034-next-catalog', migration034NextCatalog),
];
`,
      memoryPreferencesSource: `
const MEMORY_MODEL_TARGET_MIGRATIONS: Record<string, string> = {
  'openrouter/anthropic/claude-sonnet-4.6': 'openrouter/anthropic/claude-sonnet-4.7',
};
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
          'packages/db/src/migrations/033-frontier-catalog.ts',
          'migration033FrontierCatalog',
          `
            DELETE FROM models WHERE id IN ('anthropic/claude-sonnet-4.5');
            INSERT INTO models (id, provider_id, name, capabilities) VALUES
              ('anthropic/claude-sonnet-4.6', 'openrouter', 'Claude Sonnet 4.6', '{"type":"llm","streaming":true}');
          `
        ),
        migrationFile(
          'packages/db/src/migrations/034-next-catalog.ts',
          'migration034NextCatalog',
          `
            DELETE FROM models WHERE id IN ('anthropic/claude-sonnet-4.6');
            INSERT INTO models (id, provider_id, name, capabilities) VALUES
              ('anthropic/claude-sonnet-4.7', 'openrouter', 'Claude Sonnet 4.7', '{"type":"llm","streaming":true}');
          `
        ),
      ],
      migrationIndexSource: `
export const migrations = [
  migration032PreviousCatalog,
  migration033FrontierCatalog,
  migration034NextCatalog,
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

  it('does not require remaps for models reinserted by the final catalog snapshot', () => {
    const result = analyzeModelCatalogMigrationContract({
      assistantPreferencesSource: `
const MODEL_ID_MIGRATIONS: Record<SupportedProvider, Record<string, string>> = {
  openrouter: {},
};
`,
      drizzleMigrateSource: `
const customMigrations = [
  customMigration('custom-032-previous-catalog', migration032PreviousCatalog),
  customMigration('custom-033-frontier-refresh', migration033FrontierRefresh),
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
          'packages/db/src/migrations/033-frontier-refresh.ts',
          'migration033FrontierRefresh',
          `
            DELETE FROM models WHERE id IN ('anthropic/claude-sonnet-4.5');
            INSERT INTO models (id, provider_id, name, capabilities) VALUES
              ('anthropic/claude-sonnet-4.5', 'openrouter', 'Claude Sonnet 4.5', '{"type":"llm","streaming":true}');
          `
        ),
      ],
      migrationIndexSource: `
export const migrations = [
  migration032PreviousCatalog,
  migration033FrontierRefresh,
];
`,
    });

    assert.deepEqual(result.failures, []);
  });

  it('requires static provider registry models to exist in the final DB catalog', () => {
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
          `
            DELETE FROM models WHERE id IN ('gpt-next');
          `
        ),
      ],
      migrationIndexSource: `
export const migrations = [
  migration025UpdateProviderModels2026,
];
`,
      providerRegistrySource: `
const PROVIDER_DEFINITIONS = [
  {
    id: 'openai',
    models: [
      { id: 'gpt-next', type: 'llm' },
    ],
  },
  {
    id: 'ollama',
    models: [],
  },
];
`,
    });

    assert.deepEqual(result.failures, [
      {
        file: 'packages/assistant-contract/src/provider-registry.ts',
        message:
          'Static provider-registry model openai::gpt-next is missing from the final DB model catalog.',
      },
    ]);
  });

  it('rejects stale final DB catalog rows for static providers', () => {
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
          `
            INSERT INTO models (id, provider_id, name, capabilities) VALUES
              ('gpt-next', 'openai', 'GPT Next', '{"type":"llm","streaming":true}'),
              ('gpt-old', 'openai', 'GPT Old', '{"type":"llm","streaming":true}');
          `
        ),
      ],
      migrationIndexSource: `
export const migrations = [
  migration025UpdateProviderModels2026,
];
`,
      providerRegistrySource: `
const PROVIDER_DEFINITIONS = [
  {
    id: 'openai',
    models: [
      { id: 'gpt-next', type: 'llm' },
    ],
  },
];
`,
    });

    assert.deepEqual(result.failures, [
      {
        file: 'packages/assistant-contract/src/provider-registry.ts',
        message:
          'Final DB model catalog row openai::gpt-old is missing from provider-registry.ts; delete it in a catalog migration or add it to STATIC_CATALOG_STALE_ROW_ALLOWLIST.',
      },
    ]);
  });

  it('fails closed when static provider registry model fields are not resolvable', () => {
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
          `
            INSERT INTO models (id, provider_id, name, capabilities) VALUES
              ('gpt-known', 'openai', 'GPT Known', '{"type":"llm","streaming":true}');
          `
        ),
      ],
      migrationIndexSource: `
export const migrations = [
  migration025UpdateProviderModels2026,
];
`,
      providerRegistrySource: `
const PROVIDER_DEFINITIONS = [
  {
    id: 'openai',
    models: [
      { id: UNKNOWN_MODEL_ID, type: 'llm' },
      { id: 'gpt-known', type: UNKNOWN_MODEL_TYPE },
    ],
  },
];
`,
    });

    assert.deepEqual(result.failures, [
      {
        file: 'packages/assistant-contract/src/provider-registry.ts',
        message: 'Static provider-registry model for openai has an unresolvable id expression.',
      },
      {
        file: 'packages/assistant-contract/src/provider-registry.ts',
        message:
          'Static provider-registry model openai::gpt-known has an unresolvable type expression.',
      },
    ]);
  });

  it('requires static provider registry model types to match final DB catalog rows', () => {
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
          `
            INSERT INTO models (id, provider_id, name, capabilities) VALUES
              ('gpt-next', 'openai', 'GPT Next', '{"type":"embedding","streaming":false}');
          `
        ),
      ],
      migrationIndexSource: `
export const migrations = [
  migration025UpdateProviderModels2026,
];
`,
      providerRegistrySource: `
const PROVIDER_DEFINITIONS = [
  {
    id: 'openai',
    models: [
      { id: 'gpt-next', type: 'llm' },
    ],
  },
];
`,
    });

    assert.deepEqual(result.failures, [
      {
        file: 'packages/assistant-contract/src/provider-registry.ts',
        message:
          'Static provider-registry model openai::gpt-next has type llm, but the final DB model catalog has type embedding.',
      },
    ]);
  });
});
