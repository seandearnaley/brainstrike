import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  analyzeModelCatalogMigrationContract,
  CATALOG_FILE,
  findCatalogKeyOrderFailures,
  findModelsUpdatedAtWriteFailures,
} from '../model-catalog-migration-contract.mjs';

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

const providersContract = readFileSync(
  new URL('../../docs/agents/assistant-providers.md', import.meta.url),
  'utf8'
);

const shippedProviderCatalog = JSON.parse(
  readFileSync(new URL(`../../${CATALOG_FILE}`, import.meta.url), 'utf8')
);

/**
 * Build an object whose keys are in the GIVEN order. The key-order fixtures
 * below must stay out of order to mean anything, and an object literal would
 * not: Biome's `useSortedKeys` assist sorts JS object properties, so one
 * `--write` run over this file would quietly sort the fixtures and leave the
 * tests passing while asserting nothing.
 */
function objectWithKeyOrder(entries) {
  const object = {};
  for (const [key, value] of entries) {
    object[key] = value;
  }
  return object;
}

describe('model catalog migration contract', () => {
  it('documents the JSON catalog source and its enforcing script in the database contract', () => {
    assert.match(
      databaseContract,
      /^\s+- packages\/assistant-contract\/src\/provider-catalog\.json$/m,
      'docs/agents/database.md must name the catalog data file as the source to edit. ' +
        'Update the doc and assertion together.'
    );
    assert.match(
      databaseContract,
      /`scripts\/model-catalog-migration-contract\.mjs`[^\n]*read it with `JSON\.parse`/,
      'the doc must say the contract script READS the JSON rather than AST-parsing a literal'
    );
    assert.match(
      databaseContract,
      /`packages\/assistant-contract\/src\/provider-catalog-schema\.ts` does, at module load, and THROWS/,
      'the doc must record that the Zod schema replaced tsc as the catalog row check and fails closed'
    );
    assert.doesNotMatch(
      databaseContract,
      /AST-parses those structural nodes/,
      'the retired BST-1143 literal-shape rule must not linger in the contract'
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
      /On desktop, capture both `<database root>\/profiles\/<profile>\/pgdata`[\s\S]*Chromium renderer `localStorage` and `electron-storage\.json`[\s\S]*On web, capture the origin's PGlite IndexedDB store and `localStorage`[\s\S]*if any required store or a verified restore is unavailable, stop/,
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

  it('does not let DELETE patterns match into a later, unrelated statement (BST-1703)', () => {
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
          'packages/db/src/migrations/040-previous-catalog.ts',
          'migration040PreviousCatalog',
          `
            INSERT INTO models (id, provider_id, name, capabilities) VALUES
              ('phantom/crossed-1', 'openrouter', 'Phantom Crossed 1', '{"type":"llm","streaming":true}');
          `
        ),
        migrationFile(
          'packages/db/src/migrations/041-update-provider-models.ts',
          'migration041UpdateProviderModels',
          `
            DELETE FROM models WHERE provider_id = 'retired-provider';
            UPDATE models SET is_enabled = false WHERE id IN ('phantom/crossed-1');
          `
        ),
      ],
      migrationIndexSource: `
export const migrations = [
  migration040PreviousCatalog,
  migration041UpdateProviderModels,
];
`,
    });

    assert.deepEqual(result.failures, []);
  });

  it('keeps statement splitting out of string literals when scoping DELETEs (BST-1703)', () => {
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
          'packages/db/src/migrations/040-previous-catalog.ts',
          'migration040PreviousCatalog',
          `
            INSERT INTO models (id, provider_id, name, capabilities) VALUES
              ('phantom/crossed-2', 'openrouter', 'Phantom Crossed 2', '{"type":"llm","streaming":true}'),
              ('odd;id', 'openrouter', 'Odd Id', '{"type":"llm","streaming":true}');
          `
        ),
        migrationFile(
          'packages/db/src/migrations/041-update-provider-models.ts',
          'migration041UpdateProviderModels',
          `
            DELETE FROM models WHERE id = 'odd;id';
            UPDATE models SET is_enabled = false WHERE id IN ('phantom/crossed-2');
          `
        ),
      ],
      migrationIndexSource: `
export const migrations = [
  migration040PreviousCatalog,
  migration041UpdateProviderModels,
];
`,
    });

    // The DELETE of odd;id is genuine and owes both remaps; the UPDATE's
    // IN-list must not add phantom failures for phantom/crossed-2.
    assert.deepEqual(result.failures, [
      {
        file: 'packages/app-state/src/stores/assistant-model-id-migrations.ts',
        message:
          'Removed assistant catalog model openrouter::odd;id is missing from MODEL_ID_MIGRATIONS.',
      },
      {
        file: 'packages/app-state/src/stores/assistant-memory-preferences-store.ts',
        message:
          'Removed assistant memory model target openrouter/odd;id is missing from MEMORY_MODEL_TARGET_MIGRATIONS.',
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
      providerCatalog: [
        { id: 'openai', models: [{ id: 'gpt-next', type: 'llm' }] },
        { id: 'ollama', models: [] },
      ],
    });

    assert.deepEqual(result.failures, [
      {
        file: CATALOG_FILE,
        message:
          'Static catalog model openai::gpt-next is missing from the final DB model catalog.',
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
      providerCatalog: [{ id: 'openai', models: [{ id: 'gpt-next', type: 'llm' }] }],
    });

    assert.deepEqual(result.failures, [
      {
        file: CATALOG_FILE,
        message: `Final DB model catalog row openai::gpt-old is missing from ${CATALOG_FILE}; delete it in a catalog migration or add it to STATIC_CATALOG_STALE_ROW_ALLOWLIST.`,
      },
    ]);
  });

  it('rejects stale final DB catalog rows whose whole provider left the catalog', () => {
    const result = analyzeModelCatalogMigrationContract({
      migrationFiles: [
        migrationFile(
          'packages/db/src/migrations/025-update-provider-models-2026.ts',
          'migration025UpdateProviderModels2026',
          `
            INSERT INTO models (id, provider_id, name, capabilities) VALUES
              ('gpt-next', 'openai', 'GPT Next', '{"type":"llm","streaming":true}'),
              ('embed-retired', 'cohere', 'Embed Retired', '{"type":"embedding"}');
          `
        ),
      ],
      migrationIndexSource: `
export const migrations = [
  migration025UpdateProviderModels2026,
];
`,
      providerCatalog: [{ id: 'openai', models: [{ id: 'gpt-next', type: 'llm' }] }],
    });

    assert.deepEqual(result.failures, [
      {
        file: CATALOG_FILE,
        message: `Final DB model catalog row cohere::embed-retired is missing from ${CATALOG_FILE}; delete it in a catalog migration or add it to STATIC_CATALOG_STALE_ROW_ALLOWLIST.`,
      },
    ]);
  });

  it('exempts the transformers residue that migration 021 renamed with an UPDATE', () => {
    const result = analyzeModelCatalogMigrationContract({
      migrationFiles: [
        migrationFile(
          'packages/db/src/migrations/025-update-provider-models-2026.ts',
          'migration025UpdateProviderModels2026',
          `
            INSERT INTO models (id, provider_id, name, capabilities) VALUES
              ('gpt-next', 'openai', 'GPT Next', '{"type":"llm","streaming":true}'),
              ('Xenova/bge-small-en-v1.5', 'transformers', 'BGE Small', '{"type":"embedding"}');
          `
        ),
      ],
      migrationIndexSource: `
export const migrations = [
  migration025UpdateProviderModels2026,
];
`,
      providerCatalog: [{ id: 'openai', models: [{ id: 'gpt-next', type: 'llm' }] }],
    });

    assert.deepEqual(result.failures, []);
  });

  describe('models.updated_at write guard', () => {
    it('rejects a plain UPDATE that writes models.updated_at outside the allowlist', () => {
      const failures = findModelsUpdatedAtWriteFailures([
        migrationFile(
          'packages/db/src/migrations/099-fake-touch.ts',
          'migration099FakeTouch',
          `
            UPDATE models SET is_enabled = true, updated_at = CURRENT_TIMESTAMP
            WHERE id = 'openai/gpt-next';
          `
        ),
      ]);

      assert.deepEqual(failures, [
        {
          file: 'packages/db/src/migrations/099-fake-touch.ts',
          message:
            'packages/db/src/migrations/099-fake-touch.ts writes models.updated_at or ' +
            'models.created_at, which only migrations 20, 24, 28 may do ' +
            '(docs/agents/assistant-providers.md ' +
            '§ "`is_enabled` is not evidence of user intent": catalog upserts must never write ' +
            'models.updated_at or models.created_at).',
        },
      ]);
    });

    it('rejects an INSERT ... ON CONFLICT DO UPDATE SET that writes models.updated_at outside the allowlist', () => {
      const failures = findModelsUpdatedAtWriteFailures([
        migrationFile(
          'packages/db/src/migrations/099-fake-upsert.ts',
          'migration099FakeUpsert',
          `
            INSERT INTO models (id, provider_id, name, capabilities) VALUES
              ('gpt-next', 'openai', 'GPT Next', '{"type":"llm","streaming":true}')
            ON CONFLICT (id) DO UPDATE SET
              name = EXCLUDED.name,
              updated_at = CURRENT_TIMESTAMP;
          `
        ),
      ]);

      assert.deepEqual(
        failures.map((failure) => failure.file),
        ['packages/db/src/migrations/099-fake-upsert.ts']
      );
    });

    it('flags an INSERT ... SELECT ... ON CONFLICT DO UPDATE that writes models.updated_at (SELECT inside INSERT must not end the scan early)', () => {
      const failures = findModelsUpdatedAtWriteFailures([
        migrationFile(
          'packages/db/src/migrations/099-fake-insert-select.ts',
          'migration099FakeInsertSelect',
          `
            INSERT INTO models (id, name)
            SELECT id, name FROM staging
            ON CONFLICT (id) DO UPDATE SET updated_at = NOW();
          `
        ),
      ]);

      assert.deepEqual(
        failures.map((failure) => failure.file),
        ['packages/db/src/migrations/099-fake-insert-select.ts']
      );
    });

    it('flags an INSERT ... WITH cte AS (...) SELECT ... ON CONFLICT DO UPDATE that writes models.updated_at (WITH inside INSERT must not end the scan early)', () => {
      const failures = findModelsUpdatedAtWriteFailures([
        migrationFile(
          'packages/db/src/migrations/099-fake-insert-with.ts',
          'migration099FakeInsertWith',
          `
            INSERT INTO models (id, name)
            WITH staged AS (SELECT id, name FROM staging)
            SELECT id, name FROM staged
            ON CONFLICT (id) DO UPDATE SET updated_at = NOW();
          `
        ),
      ]);

      assert.deepEqual(
        failures.map((failure) => failure.file),
        ['packages/db/src/migrations/099-fake-insert-with.ts']
      );
    });

    it('flags a models UPDATE with no trailing semicolon (re-review finding 1: a `;`-anchored pattern is a blind spot)', () => {
      // 006-embedding-sets-and-columns.ts already ends its `up` SQL without a
      // trailing semicolon (comments only after the last real statement), so
      // a future migration in that shape must not slip past this guard.
      const failures = findModelsUpdatedAtWriteFailures([
        migrationFile(
          'packages/db/src/migrations/099-fake-no-semicolon.ts',
          'migration099FakeNoSemicolon',
          `
            UPDATE models SET updated_at = NOW() WHERE id = 'x'
          `
        ),
      ]);

      assert.deepEqual(
        failures.map((failure) => failure.file),
        ['packages/db/src/migrations/099-fake-no-semicolon.ts']
      );
    });

    it('does not let a providers statement swallow into an unterminated models statement (re-review finding 2: table confusion via the terminator)', () => {
      // The models statement has no trailing `;`; a lazy `;`-anchored match
      // would swallow the providers statement's `updated_at = NOW()` into the
      // same match and wrongly flag the models file for a providers write —
      // exactly the table confusion this guard exists to avoid.
      const failures = findModelsUpdatedAtWriteFailures([
        migrationFile(
          'packages/db/src/migrations/099-fake-table-confusion.ts',
          'migration099FakeTableConfusion',
          `
            UPDATE models SET is_enabled = true WHERE id = 'x'
            UPDATE providers SET updated_at = NOW();
          `
        ),
      ]);

      assert.deepEqual(failures, []);
    });

    it('flags a models INSERT whose string literal contains a semicolon (re-review finding 3: a `;` inside a string literal truncates the match)', () => {
      const failures = findModelsUpdatedAtWriteFailures([
        migrationFile(
          'packages/db/src/migrations/099-fake-semicolon-in-literal.ts',
          'migration099FakeSemicolonInLiteral',
          `
            INSERT INTO models (id, name) VALUES ('a', 'b;c') ON CONFLICT (id) DO UPDATE SET updated_at = NOW();
          `
        ),
      ]);

      assert.deepEqual(
        failures.map((failure) => failure.file),
        ['packages/db/src/migrations/099-fake-semicolon-in-literal.ts']
      );
    });

    it('flags a public.models UPDATE (re-review finding 4: `public.models` is not matched)', () => {
      const failures = findModelsUpdatedAtWriteFailures([
        migrationFile(
          'packages/db/src/migrations/099-fake-public-schema.ts',
          'migration099FakePublicSchema',
          `
            UPDATE public.models SET updated_at = NOW() WHERE id = 'x';
          `
        ),
      ]);

      assert.deepEqual(
        failures.map((failure) => failure.file),
        ['packages/db/src/migrations/099-fake-public-schema.ts']
      );
    });

    it('flags a fully-quoted "public"."models" UPDATE (BST-1794 follow-up: a quoted schema is not one blob)', () => {
      const failures = findModelsUpdatedAtWriteFailures([
        migrationFile(
          'packages/db/src/migrations/099-fake-quoted-public-schema.ts',
          'migration099FakeQuotedPublicSchema',
          `
            UPDATE "public"."models" SET updated_at = NOW();
          `
        ),
      ]);

      assert.deepEqual(
        failures.map((failure) => failure.file),
        ['packages/db/src/migrations/099-fake-quoted-public-schema.ts']
      );
    });

    it('flags an unquoted-schema, quoted-table INSERT (BST-1794 follow-up: public."models")', () => {
      const failures = findModelsUpdatedAtWriteFailures([
        migrationFile(
          'packages/db/src/migrations/099-fake-mixed-quoting.ts',
          'migration099FakeMixedQuoting',
          `
            INSERT INTO public."models" (id) VALUES ('x') ON CONFLICT (id) DO UPDATE SET updated_at = NOW();
          `
        ),
      ]);

      assert.deepEqual(
        failures.map((failure) => failure.file),
        ['packages/db/src/migrations/099-fake-mixed-quoting.ts']
      );
    });

    it('does not flag a models_archive UPDATE (BST-1794 follow-up: the schema-qualified pattern must not widen past the table boundary)', () => {
      const failures = findModelsUpdatedAtWriteFailures([
        migrationFile(
          'packages/db/src/migrations/099-fake-models-archive.ts',
          'migration099FakeModelsArchive',
          `
            UPDATE models_archive SET updated_at = NOW();
          `
        ),
      ]);

      assert.deepEqual(failures, []);
    });

    it('allows the three known-legitimate local-provider migrations (020, 024, 028)', () => {
      // These are shaped after the real up-blocks from the shipped migrations
      // (abbreviated, not verbatim — e.g. the 020 fixture below carries only
      // one row): 020 and 028 upsert local-provider ONNX rows with
      // `ON CONFLICT ... DO UPDATE SET ... updated_at = CURRENT_TIMESTAMP`;
      // 024 patches the same rows' capabilities with a plain
      // `UPDATE ... SET updated_at = CURRENT_TIMESTAMP`.
      const failures = findModelsUpdatedAtWriteFailures([
        migrationFile(
          'packages/db/src/migrations/020-local-llm-models.ts',
          'migration020LocalLlmModels',
          `
            INSERT INTO models (id, provider_id, name, is_enabled) VALUES
              ('LiquidAI/LFM2.5-1.2B-Instruct-ONNX', 'transformers', 'LFM2.5', false)
            ON CONFLICT (id) DO UPDATE SET
              name = EXCLUDED.name,
              updated_at = CURRENT_TIMESTAMP;
          `
        ),
        migrationFile(
          'packages/db/src/migrations/024-fix-llm-tool-calling.ts',
          'migration024FixLlmToolCalling',
          `
            UPDATE models SET capabilities = '{}', updated_at = CURRENT_TIMESTAMP
            WHERE id = 'LiquidAI/LFM2.5-1.2B-Instruct-ONNX';
          `
        ),
        migrationFile(
          'packages/db/src/migrations/028-gemma-local-llm.ts',
          'migration028GemmaLocalLlm',
          `
            INSERT INTO models (id, provider_id, name, is_enabled) VALUES
              ('onnx-community/gemma-4-E2B-it-ONNX', 'local', 'Gemma 4 E2B', true)
            ON CONFLICT (id) DO UPDATE SET
              name = EXCLUDED.name,
              updated_at = CURRENT_TIMESTAMP;
          `
        ),
      ]);

      assert.deepEqual(failures, []);
    });

    it('does not confuse migration 021s plain UPDATE (no updated_at) with a write', () => {
      const failures = findModelsUpdatedAtWriteFailures([
        migrationFile(
          'packages/db/src/migrations/021-rename-transformers-to-local.ts',
          'migration021RenameTransformersToLocal',
          `
            UPDATE models SET provider_id = 'local' WHERE provider_id = 'transformers';
            UPDATE models SET is_enabled = true WHERE id = 'onnx-community/functiongemma-270m-it-ONNX';
          `
        ),
      ]);

      assert.deepEqual(failures, []);
    });

    it('does not confuse providers.updated_at with models.updated_at', () => {
      // Migration 023's real shape: `UPDATE providers SET ... updated_at = NOW()`.
      // A matcher keyed on the substring "updated_at" rather than the target
      // table would wrongly flag this.
      const failures = findModelsUpdatedAtWriteFailures([
        migrationFile(
          'packages/db/src/migrations/023-fix-local-provider-enabled.ts',
          'migration023FixLocalProviderEnabled',
          `
            UPDATE providers SET is_enabled = true, sort_order = 4, updated_at = NOW() WHERE id = 'local';
          `
        ),
      ]);

      assert.deepEqual(failures, []);
    });

    it('does not confuse an ALTER TABLE models ALTER COLUMN updated_at with a row write', () => {
      // Migration 031's real shape: a schema-level DEFAULT change, not a row write.
      const failures = findModelsUpdatedAtWriteFailures([
        migrationFile(
          'packages/db/src/migrations/031-provider-catalog-timestamps.ts',
          'migration031ProviderCatalogTimestamps',
          `
            ALTER TABLE models
              ALTER COLUMN updated_at DROP DEFAULT,
              ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz,
              ALTER COLUMN updated_at SET DEFAULT NOW();
          `
        ),
      ]);

      assert.deepEqual(failures, []);
    });

    it('runs the updated_at write guard through the full contract analysis, not just the helper', () => {
      const result = analyzeModelCatalogMigrationContract({
        migrationFiles: [
          migrationFile(
            'packages/db/src/migrations/099-fake-touch.ts',
            'migration099FakeTouch',
            `
              UPDATE models SET updated_at = CURRENT_TIMESTAMP WHERE id = 'openai/gpt-next';
            `
          ),
        ],
        migrationIndexSource: `
export const migrations = [
  migration099FakeTouch,
];
`,
      });

      assert.ok(
        result.failures.some((failure) => failure.message.includes('writes models.updated_at')),
        'analyzeModelCatalogMigrationContract must surface the updated_at write guard'
      );
    });
  });

  it('fails closed when static catalog model fields are malformed', () => {
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
      providerCatalog: [
        {
          id: 'openai',
          models: [{ type: 'llm' }, { id: 'gpt-known', type: 7 }],
        },
      ],
    });

    assert.deepEqual(result.failures, [
      {
        file: CATALOG_FILE,
        message: 'A model entry for openai is missing a string id.',
      },
      {
        file: CATALOG_FILE,
        message: 'Catalog model openai::gpt-known is missing a string type.',
      },
    ]);
  });

  it('fails closed when the catalog file is not a JSON array', () => {
    const result = analyzeModelCatalogMigrationContract({
      migrationFiles: [],
      migrationIndexSource: 'export const migrations = [];',
      providerCatalog: { openai: [] },
    });

    assert.deepEqual(result.failures, [
      {
        file: CATALOG_FILE,
        message: 'The provider catalog must be a JSON array of provider objects.',
      },
    ]);
  });

  it('fails closed when a provider entry has no models array', () => {
    const result = analyzeModelCatalogMigrationContract({
      migrationFiles: [],
      migrationIndexSource: 'export const migrations = [];',
      providerCatalog: [{ id: 'openai' }, 'openrouter', { models: [] }],
    });

    assert.deepEqual(result.failures, [
      { file: CATALOG_FILE, message: 'Provider openai must declare a models array.' },
      { file: CATALOG_FILE, message: 'Provider catalog entries must be objects.' },
      { file: CATALOG_FILE, message: 'Provider catalog entry is missing a string id.' },
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
      providerCatalog: [{ id: 'openai', models: [{ id: 'gpt-next', type: 'llm' }] }],
    });

    assert.deepEqual(result.failures, [
      {
        file: CATALOG_FILE,
        message:
          'Static catalog model openai::gpt-next has type llm, but the final DB model catalog has type embedding.',
      },
    ]);
  });

  it('rejects catalog objects whose keys are out of alphabetical order', () => {
    const result = analyzeModelCatalogMigrationContract({
      migrationFiles: [
        migrationFile(
          'packages/db/src/migrations/025-update-provider-models-2026.ts',
          'migration025UpdateProviderModels2026',
          `
            INSERT INTO models (id, provider_id, name, capabilities) VALUES
              ('gpt-next', 'openai', 'GPT Next', '{"type":"llm","streaming":true}');
          `
        ),
      ],
      migrationIndexSource: `
export const migrations = [
  migration025UpdateProviderModels2026,
];
`,
      providerCatalog: [
        objectWithKeyOrder([
          [
            'models',
            [
              objectWithKeyOrder([
                ['type', 'llm'],
                ['id', 'gpt-next'],
              ]),
            ],
          ],
          ['id', 'openai'],
        ]),
      ],
    });

    assert.deepEqual(result.failures, [
      {
        file: CATALOG_FILE,
        message:
          'Catalog entry openai declares "id" after "models"; provider-catalog.json object keys are alphabetical at every depth so catalog edits stay reviewable data diffs. Reorder this entry\'s keys.',
      },
      {
        file: CATALOG_FILE,
        message:
          'Catalog entry openai.models.gpt-next declares "id" after "type"; provider-catalog.json object keys are alphabetical at every depth so catalog edits stay reviewable data diffs. Reorder this entry\'s keys.',
      },
    ]);
  });

  it('names ONE offending key per object rather than every pair a shuffle disturbs', () => {
    const failures = findCatalogKeyOrderFailures([
      objectWithKeyOrder([
        ['runtime', 'hosted'],
        ['id', 'openai'],
        ['models', []],
        ['displayName', 'OpenAI'],
      ]),
    ]);

    assert.deepEqual(
      failures.map((failure) => failure.message),
      [
        'Catalog entry openai declares "id" after "runtime"; provider-catalog.json object keys are alphabetical at every depth so catalog edits stay reviewable data diffs. Reorder this entry\'s keys.',
      ],
      'a reviewer needs the first key to move, not one failure per disturbed pair'
    );
  });

  it('accepts _note first and reports a nested object by its own path', () => {
    const failures = findCatalogKeyOrderFailures([
      {
        _note: 'vendor citation',
        id: 'openai',
        models: [
          objectWithKeyOrder([
            ['_note', 'row citation'],
            ['id', 'gpt-next'],
            [
              'pricing',
              objectWithKeyOrder([
                ['outputPerMTok', 30],
                ['inputPerMTok', 5],
              ]),
            ],
            ['type', 'llm'],
          ]),
        ],
      },
    ]);

    assert.deepEqual(
      failures.map((failure) => failure.message),
      [
        'Catalog entry openai.models.gpt-next.pricing declares "inputPerMTok" after "outputPerMTok"; provider-catalog.json object keys are alphabetical at every depth so catalog edits stay reviewable data diffs. Reorder this entry\'s keys.',
      ],
      '`_note` sorts before every other catalog key, and nested objects are checked too'
    );
  });

  it('holds the shipped catalog to the order it already keeps', () => {
    assert.deepEqual(findCatalogKeyOrderFailures(shippedProviderCatalog), []);
  });

  it('leaves the curated ROW order of providers and models alone', () => {
    // The catalog lists `gpt-5.6-sol` before `gpt-5.6-terra` and
    // `claude-opus-5` before `claude-sonnet-5`: editorial order no comparator
    // derives. Only KEY order is mechanical, so only KEY order is enforced.
    const [openai] = shippedProviderCatalog;
    const modelIds = openai.models.map((model) => model.id);

    assert.notDeepEqual(
      modelIds,
      [...modelIds].sort(),
      'if the shipped row order ever becomes sorted, re-derive the rule instead of assuming it'
    );
    assert.deepEqual(findCatalogKeyOrderFailures(shippedProviderCatalog), []);
  });

  it('runs the key-order rule through the CI entrypoint, not just the helper', async () => {
    // Review finding on #3016: the two existing order tests each miss the wiring
    // from opposite sides — one calls the helper directly, the other always
    // passes `providerCatalog` explicitly. Neither would notice if the CI
    // entrypoint stopped supplying the catalog and the rule silently stopped
    // running. This asserts the real entrypoint reads the shipped file and
    // reaches the rule.
    const source = readFileSync(new URL(`../../${CATALOG_FILE}`, import.meta.url), 'utf8');
    const unsorted = JSON.parse(source);
    const firstModel = unsorted[0]?.models?.[0];
    assert.ok(firstModel, 'shipped catalog must have a model to reorder');
    const reordered = Object.fromEntries(Object.entries(firstModel).reverse());
    unsorted[0].models[0] = reordered;

    const failures = findCatalogKeyOrderFailures(unsorted);
    assert.ok(failures.length > 0, 'reversing a real model row must produce a key-order failure');

    // And the entrypoint the CI script calls must feed the catalog in.
    const entrypointSource = readFileSync(
      new URL('../model-catalog-migration-contract.mjs', import.meta.url),
      'utf8'
    );
    assert.match(
      entrypointSource,
      /providerCatalog: JSON\.parse\(providerCatalogSource\)/,
      'checkModelCatalogMigrationContract must pass the parsed catalog, or the key-order rule stops running in CI'
    );
  });

  it('documents the catalog key-order rule in the providers contract', () => {
    assert.match(
      providersContract,
      /object keys are alphabetical at every depth/,
      'docs/agents/assistant-providers.md must state the rule findCatalogKeyOrderFailures enforces'
    );
    assert.match(
      providersContract,
      /`scripts\/model-catalog-migration-contract\.mjs`[^\n]*\n?[^\n]*enforces/,
      'the doc must name the script that enforces it, so an editor knows what will fail'
    );
  });
});
