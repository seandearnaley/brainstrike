import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planModelCatalogMigration } from '../gen-model-catalog-migration.mjs';
import { analyzeModelCatalogMigrationContract } from '../model-catalog-migration-contract.mjs';

/**
 * BST-1650: the generator turns the ADD half of the catalog/`models` mirroring
 * into a mechanical step. Its output has to satisfy the same contract checker
 * that guards hand-written catalog migrations, so the last test here feeds a
 * generated migration straight back through
 * `analyzeModelCatalogMigrationContract`.
 */

const MIGRATION_INDEX_SOURCE = `// Import all migrations
import { migration025UpdateProviderModels2026 } from './025-update-provider-models-2026.js';

export const migrations: Migration[] = [
  migration025UpdateProviderModels2026,
];

export { MigrationRunner } from './migration-runner.js';
`;

function seedMigration(body) {
  return {
    file: 'packages/db/src/migrations/025-update-provider-models-2026.ts',
    source: `
import type { Migration } from './migration-runner';

export const migration025UpdateProviderModels2026: Migration = {
  version: 25,
  ledgerKey: 'custom-025-update-provider-models-2026',
  name: 'update_provider_models_2026',
  up: \`
    ${body}
  \`,
  down: \`\`,
};
`,
  };
}

const SEEDED_OPENAI_ROW = seedMigration(`
  INSERT INTO models (id, provider_id, name, capabilities) VALUES
    ('gpt-seeded', 'openai', 'GPT Seeded', '{"type":"llm","streaming":true,"vision":true}');
`);

function llmModel(overrides = {}) {
  return {
    contextWindow: 400_000,
    id: 'gpt-new',
    label: 'GPT New',
    supportsStreaming: true,
    type: 'llm',
    vision: 'supported',
    ...overrides,
  };
}

const SEEDED_CATALOG_MODEL = llmModel({ id: 'gpt-seeded', label: 'GPT Seeded' });

function catalog(models, providerId = 'openai') {
  return [{ id: providerId, models }];
}

/**
 * The seeded row is part of the catalog in every case except the deliberate
 * "a row disappeared" test, so `plan` prepends it. Leaving it out by accident
 * would make every case exercise the add-only refusal instead of generation.
 */
function plan(newModels, { migrationFiles = [SEEDED_OPENAI_ROW] } = {}) {
  return planModelCatalogMigration({
    migrationFiles,
    migrationIndexSource: MIGRATION_INDEX_SOURCE,
    providerCatalog: catalog([SEEDED_CATALOG_MODEL, ...newModels]),
  });
}

describe('gen-model-catalog-migration', () => {
  it('generates nothing when the DB catalog already covers every catalog row', () => {
    const result = plan([]);

    assert.deepEqual(result.additions, []);
    assert.equal(result.migration, null);
  });

  it('preserves the user is_enabled toggle on conflict', () => {
    const { migration } = plan([llmModel()]);

    assert.match(migration.source, /is_enabled = models\.is_enabled;/);
    assert.doesNotMatch(
      migration.source,
      /is_enabled = EXCLUDED\.is_enabled/,
      'EXCLUDED.is_enabled clobbers the user model toggle (database.md rule 3)'
    );
  });

  it('seeds new rows disabled so a catalog add never silently enables a model', () => {
    const { migration } = plan([llmModel()]);

    assert.match(migration.source, /\n {8}false\n {6}\)/);
  });

  it('derives LLM capabilities from the catalog row', () => {
    const { migration } = plan([llmModel({ vision: 'unsupported' })]);

    assert.match(migration.source, /\{"streaming":true,"type":"llm","vision":false\}/);
  });

  it('derives embedding capabilities from the catalog row', () => {
    const { migration } = plan([
      {
        defaultDimension: 768,
        id: 'text-embed-new',
        supportsStandardDimension: true,
        type: 'embedding',
      },
    ]);

    assert.match(migration.source, /\{"defaultDimension":768,"type":"embedding"\}/);
    assert.match(migration.source, /'text-embed-new',/);
  });

  it('leaves tagline and best_for to their own source rather than mirroring composer copy', () => {
    const { migration } = plan([llmModel({ tagline: 'Best mix of smarts and speed' })]);

    const columnList = migration.source.match(/INSERT INTO models\n\s+\(([^)]*)\)/)?.[1];

    assert.equal(columnList, 'id, provider_id, name, capabilities, sort_order, is_enabled');
    assert.doesNotMatch(
      migration.source,
      /Best mix of smarts and speed/,
      'the registry composer tagline must never be copied into the db-explorer column'
    );
  });

  it('appends sort_order per provider with a distinct offset for each new row', () => {
    const { migration } = plan([llmModel({ id: 'gpt-a' }), llmModel({ id: 'gpt-b' })]);

    assert.match(
      migration.source,
      /\(SELECT COALESCE\(MAX\(sort_order\), 0\) FROM models WHERE provider_id = 'openai'\) \+ 1/
    );
    assert.match(
      migration.source,
      /\(SELECT COALESCE\(MAX\(sort_order\), 0\) FROM models WHERE provider_id = 'openai'\) \+ 2/
    );
  });

  it('registers the migration in the numbered manifest, which derives the Drizzle ledger', () => {
    const { migration } = plan([llmModel()]);

    assert.equal(migration.version, 26);
    assert.equal(migration.file, 'packages/db/src/migrations/026-openai-gpt-new.ts');
    assert.equal(migration.ledgerKey, 'custom-026-openai-gpt-new');
    assert.match(migration.source, /ledgerKey: 'custom-026-openai-gpt-new'/);
    assert.match(
      migration.indexSource,
      /import \{ migration026OpenaiGptNew \} from '\.\/026-openai-gpt-new\.js';/
    );
    assert.match(migration.indexSource, /\n {2}migration026OpenaiGptNew,\n\];/);
  });

  it('refuses to generate when a catalog row disappeared, because that needs remap decisions', () => {
    assert.throws(
      () =>
        planModelCatalogMigration({
          migrationFiles: [SEEDED_OPENAI_ROW],
          migrationIndexSource: MIGRATION_INDEX_SOURCE,
          providerCatalog: catalog([llmModel()]),
        }),
      { message: /add-only[\s\S]*openai::gpt-seeded/ }
    );
  });

  it('refuses an LLM row that does not declare vision', () => {
    assert.throws(() => plan([llmModel({ vision: undefined })]), {
      message: /openai::gpt-new must declare vision/,
    });
  });

  it('refuses an LLM row that does not declare supportsStreaming', () => {
    assert.throws(() => plan([llmModel({ supportsStreaming: undefined })]), {
      message: /openai::gpt-new must declare supportsStreaming/,
    });
  });

  it('emits a migration the model catalog contract checker accepts', () => {
    const { migration } = plan([llmModel()]);

    const result = analyzeModelCatalogMigrationContract({
      migrationFiles: [SEEDED_OPENAI_ROW, { file: migration.file, source: migration.source }],
      migrationIndexSource: migration.indexSource,
      providerCatalog: catalog([SEEDED_CATALOG_MODEL, llmModel()]),
    });

    assert.deepEqual(result.failures, []);
    assert.ok(result.catalogMutatingMigrations.includes(migration.exportName));
  });
});
