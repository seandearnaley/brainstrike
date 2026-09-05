import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  ledgerKey: 'custom-025-fixture',
  name: 'fixture',
  up: \`
    ${body}
  \`,
  down: \`\`,
};
`,
  };
}

const databaseContract = readFileSync(
  new URL('../../docs/agents/database.md', import.meta.url),
  'utf8'
);

describe('model catalog migration contract', () => {
  it('documents the provider registry static-literal requirement in the database contract', () => {
    assert.match(
      databaseContract,
      /^\s+- packages\/assistant-contract\/src\/provider-registry\.ts\n\s+- Keep `PROVIDER_DEFINITIONS` as an array literal, each provider entry as an object literal, each provider's `models` property as an array literal, and each model entry as an object literal\. `scripts\/model-catalog-migration-contract\.mjs` AST-parses those structural nodes; scalar provider\/model fields may reference resolvable string constants\.$/m,
      'docs/agents/database.md must keep the complete provider-registry literal-shape rule next ' +
        'to its source path and name the enforcing script. Update the doc and assertion together.'
    );
  });

  it('documents the safe procedure for catalog rollback with live user data', () => {
    assert.match(
      databaseContract,
      /^### SAFE CATALOG ROLLBACK WITH LIVE USER DATA$/m,
      'the database contract must retain the catalog rollback safety section'
    );
    assert.match(
      databaseContract,
      /no shipped production `down` path[\s\S]*append-only `__drizzle_migrations` ledger[\s\S]*Never execute raw `down` SQL or edit the production ledger/,
      'the runbook must forbid unsupported production down SQL and ledger edits'
    );
    assert.match(
      databaseContract,
      /On desktop, capture both `Documents\/BrainStrike\[-dev\]\/profiles\/<profile>\/pgdata`[\s\S]*Chromium renderer `localStorage` and `electron-storage\.json`[\s\S]*On web, capture the origin's PGlite IndexedDB store and `localStorage`[\s\S]*if any required store or a verified restore is unavailable, stop/,
      'the runbook must enumerate every platform-specific store and fail closed without a verified restore'
    );
    assert.match(
      databaseContract,
      /Query PGlite tables such as `models`, `brainstrike_assistant_thread_runs\.model`, and `brainstrike_assistant_run_usage\.model`[\s\S]*`assistant-preferences\.v1` in renderer `window\.localStorage` on desktop and web[\s\S]*`assistant-memory-preferences\.v1` through the Electron storage bridge \(`electron-storage\.json`\) on desktop or browser `localStorage` on web/,
      'the runbook must map SQL and each persisted JSON key to its actual platform storage'
    );
    assert.match(
      databaseContract,
      /Preserve historical run model text[\s\S]*never disable the constraint or cascade-delete user history/,
      'the runbook must preserve provenance and fail closed on present or future constraints'
    );
    assert.match(
      databaseContract,
      /Remap only mutable preference state[\s\S]*store-version bump[\s\S]*replacement exists in the target catalog/,
      'the runbook must constrain preference remaps and verify their catalog target'
    );
    assert.match(
      databaseContract,
      /production Drizzle runner and its real ledger state[\s\S]*numbered-runner `down` then `up` behavior[\s\S]*not a production deployment path/,
      'the runbook must distinguish test rollback verification from production recovery'
    );
    assert.match(
      databaseContract,
      /Apply only the reviewed forward migration through the production Drizzle runner[\s\S]*verify migration-ledger state[\s\S]*historical thread rendering/,
      'the runbook must return to the live profile only through reviewed forward migration'
    );
  });

  it('accepts catalog migrations registered only in the numbered manifest', () => {
    const result = analyzeModelCatalogMigrationContract({
      migrationFiles: [
        migrationFile(
          'packages/db/src/migrations/025-update-provider-models-2026.ts',
          'migration025UpdateProviderModels2026',
          "INSERT INTO models (id, provider_id) VALUES ('gpt-next', 'openai');"
        ),
      ],
      migrationIndexSource,
    });

    assert.deepEqual(result.failures, []);
  });

  it('fails closed when a catalog-mutating migration has no recognizable export declaration', () => {
    const result = analyzeModelCatalogMigrationContract({
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

  it('requires catalog migrations to stay registered in the numbered manifest', () => {
    const result = analyzeModelCatalogMigrationContract({
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
    ]);
  });

  it('requires preference remaps for removed assistant model IDs', () => {
    const result = analyzeModelCatalogMigrationContract({
      assistantPreferencesSource: `
const MODEL_ID_MIGRATIONS: Record<SupportedProvider, Record<string, string>> = {
  openrouter: {},
};
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
        file: 'packages/app-state/src/stores/assistant-model-id-migrations.ts',
        message:
          'Removed assistant catalog model openrouter::anthropic/claude-sonnet-4.5 is missing from MODEL_ID_MIGRATIONS.',
      },
      {
        file: 'packages/app-state/src/stores/assistant-memory-preferences-store.ts',
        message:
          'Removed assistant memory model target openrouter/anthropic/claude-sonnet-4.5 is missing from MEMORY_MODEL_TARGET_MIGRATIONS.',
      },
    ]);
  });

  it('preserves the historical remap cutoff for Windows migration paths', () => {
    const result = analyzeModelCatalogMigrationContract({
      assistantPreferencesSource: `
const MODEL_ID_MIGRATIONS: Record<SupportedProvider, Record<string, string>> = {
  openrouter: {},
};
`,
      memoryPreferencesSource: `
const MEMORY_MODEL_TARGET_MIGRATIONS: Record<string, string> = {};
`,
      migrationFiles: [
        migrationFile(
          'packages\\db\\src\\migrations\\031-previous-catalog.ts',
          'migration031PreviousCatalog',
          `
            INSERT INTO models (id, provider_id, name, capabilities) VALUES
              ('anthropic/claude-sonnet-3.5', 'openrouter', 'Claude Sonnet 3.5', '{"type":"llm","streaming":true}');
          `
        ),
        migrationFile(
          'packages\\db\\src\\migrations\\032-historical-refresh.ts',
          'migration032HistoricalRefresh',
          `
            DELETE FROM models WHERE id IN ('anthropic/claude-sonnet-3.5');
          `
        ),
      ],
      migrationIndexSource: `
export const migrations = [
  migration031PreviousCatalog,
  migration032HistoricalRefresh,
];
`,
    });

    assert.deepEqual(result.failures, []);
  });

  it('enforces the remap contract for current Windows migration paths', () => {
    const result = analyzeModelCatalogMigrationContract({
      assistantPreferencesSource: `
const MODEL_ID_MIGRATIONS: Record<SupportedProvider, Record<string, string>> = {
  openrouter: {},
};
`,
      memoryPreferencesSource: `
const MEMORY_MODEL_TARGET_MIGRATIONS: Record<string, string> = {};
`,
      migrationFiles: [
        migrationFile(
          'packages\\db\\src\\migrations\\033-previous-catalog.ts',
          'migration033PreviousCatalog',
          `
            INSERT INTO models (id, provider_id, name, capabilities) VALUES
              ('anthropic/claude-sonnet-4.6', 'openrouter', 'Claude Sonnet 4.6', '{"type":"llm","streaming":true}');
          `
        ),
        migrationFile(
          'packages\\db\\src\\migrations\\034-current-refresh.ts',
          'migration034CurrentRefresh',
          `
            DELETE FROM models WHERE id IN ('anthropic/claude-sonnet-4.6');
          `
        ),
      ],
      migrationIndexSource: `
export const migrations = [
  migration033PreviousCatalog,
  migration034CurrentRefresh,
];
`,
    });

    assert.deepEqual(result.failures, [
      {
        file: 'packages/app-state/src/stores/assistant-model-id-migrations.ts',
        message:
          'Removed assistant catalog model openrouter::anthropic/claude-sonnet-4.6 is missing from MODEL_ID_MIGRATIONS.',
      },
      {
        file: 'packages/app-state/src/stores/assistant-memory-preferences-store.ts',
        message:
          'Removed assistant memory model target openrouter/anthropic/claude-sonnet-4.6 is missing from MEMORY_MODEL_TARGET_MIGRATIONS.',
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
        file: 'packages/app-state/src/stores/assistant-model-id-migrations.ts',
        message:
          'Removed assistant catalog model openrouter::anthropic/claude-sonnet-4.5 is missing from MODEL_ID_MIGRATIONS.',
      },
      {
        file: 'packages/app-state/src/stores/assistant-memory-preferences-store.ts',
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
