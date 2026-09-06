import { PGlite } from '@electric-sql/pglite';
import { expect, it, vi } from 'vitest';
import { customMigrations, runMigrations } from '../src/drizzle/migrate.js';
import migrationsManifest from '../src/drizzle/migrations.json';
import { migration015ModelRegistry } from '../src/migrations/015-model-registry.js';
import { TEST_ENGINE_EXTENSIONS } from './helpers/migrated-test-db.js';

// Shipped __drizzle_migrations.hash values, captured from the pre-BST-1643 hand list.
// Never regenerate this oracle from the numbered manifest.
const shippedLedgerKeys = [
  'custom-015-model-registry-seed',
  'custom-020-local-llm-models',
  'custom-021-rename-transformers-to-local',
  'custom-022-enable-default-embedding-models',
  'custom-023-fix-local-provider-enabled',
  'custom-024-fix-llm-tool-calling',
  'custom-025-update-provider-models-2026',
  'custom-026-update-provider-models-2026-v2',
  'custom-027-view-filter-presets-seed',
  'custom-028-gemma-local-llm',
  'custom-030-collection-indexing-stats',
  'custom-032-file-chunk-source-ranges',
  'custom-033-update-provider-models-2026-frontier',
  'custom-034-tsvector-generated-column',
  'custom-035-uuidv7-primary-keys',
  'custom-036-workspace-index-system-role',
  'custom-037-file-record-mtime-ms',
  'custom-038-pg-trgm-grep-index',
  'custom-039-roots-table',
  'custom-040-retire-source-root-path',
  'custom-041-roots-path-identity',
  'custom-042-job-queue-chunk-id',
  'custom-043-job-queue-embedding-set-id',
  'custom-044-dimension-index-suspensions',
  'custom-045-dimension-index-maintenance',
  'custom-046-assistant-run-usage',
  'custom-047-run-usage-root-id',
  'custom-048-file-records-name-trgm',
  'custom-049-job-queue-metrics',
  'custom-050-assistant-task-lists',
  'custom-051-prompt-library',
  'custom-052-assistant-edit-checkpoints',
  'custom-053-bm25-content-index',
  'custom-054-assistant-thread-groups',
  'custom-055-assistant-message-parents',
  'custom-056-assistant-thread-group-presentation',
  'custom-057-update-provider-models-2026-07',
  'custom-058-provider-billed-cost',
  'custom-059-assistant-thread-group-icons',
  'custom-060-openrouter-spark-kimi-k3',
  'custom-061-model-vision-capability',
  'custom-062-assistant-run-outcomes',
  'custom-063-index-consolidation',
  'custom-064-job-queue-outcome-metrics',
  'custom-065-quarantine-pg-textsearch',
  'custom-066-restore-pg-textsearch',
  'custom-067-thread-search-index',
  'custom-068-tool-output-artifacts',
  'custom-069-run-usage-cache-tokens',
  'custom-070-minimax-m3-vision',
  'custom-071-openrouter-july-coding-models',
  'custom-072-openrouter-ling-3-flash',
  'custom-073-diagnostic-events',
  'custom-074-agent-readonly-role',
  'custom-075-file-symbols',
  'custom-076-assistant-run-errors',
  'custom-077-run-usage-kind',
  'custom-078-job-queue-dedupe-active-index',
  'custom-079-mind-ops-log',
  'custom-080-assistant-message-tombstones',
  'custom-081-workspace-snapshots',
  'custom-082-canvas-documents',
  'custom-083-tool-call-telemetry',
  'custom-084-assistant-tool-projection-rewrites',
  'custom-085-tool-call-telemetry-occurred-at-index',
  'custom-086-token-estimate-calibration',
  'custom-087-tool-projection-rewrite-kinds',
  'custom-088-assistant-compaction-ranges',
  'custom-089-token-estimate-calibration-resolved-budgets',
  'custom-090-compaction-summary-run-usage-kind',
  'custom-091-token-estimate-calibration-prompt-baseline',
  'custom-092-tool-call-telemetry-substrate-split',
  'custom-093-assistant-run-treatments',
  'custom-094-openrouter-gemini-3-7-flash',
  'custom-095-assistant-thread-workspaces',
  'custom-096-openrouter-qwen-3-8-27b',
  'custom-097-openrouter-qwen-3-8-2-4t-a95b',
  'custom-098-openrouter-qwen-3-8-max',
  'custom-099-openrouter-nemotron-3-5-lightning',
  'custom-100-openrouter-grok-4-6',
  'custom-101-amazon-bedrock',
  'custom-102-amazon-nova-2-lite',
  'custom-103-openai-codex',
  'custom-104-google-gemini-3-7-flash',
  'custom-105-embedding-job-input-hash',
  'custom-106-openrouter-muse-spark-1-2',
  'custom-107-openrouter-ox-alpha',
  'custom-108-openrouter-glm-5-3',
  'custom-109-worktrees',
  'custom-110-forge-pr-cache',
  'custom-111-roots-worktree-kind',
  'custom-112-worktree-setup-reason',
  'custom-113-openrouter-qwen-3-8-flash',
  'custom-114-mcp-tasks',
  'custom-115-mcp-task-authority',
];

it('preserves all 95 shipped custom ledger keys in order', () => {
  // Prefix-only: appending a new migration must never require editing this oracle,
  // so the fast way out of a red test is never "paste the derived list back".
  expect(
    customMigrations.slice(0, shippedLedgerKeys.length).map((migration) => migration.hash)
  ).toEqual(shippedLedgerKeys);
  expect(customMigrations.length).toBeGreaterThanOrEqual(shippedLedgerKeys.length);
});

it('preserves the original customMigration object shape', () => {
  expect(customMigrations[0]).toEqual({
    hash: shippedLedgerKeys[0],
    name: migration015ModelRegistry.name,
    sql: migration015ModelRegistry.up,
    version: String(migration015ModelRegistry.version),
  });
});

it('opens an existing ledger with zero re-applied migrations', async () => {
  const db = new PGlite({ extensions: TEST_ENGINE_EXTENSIONS });
  try {
    // Use the shipped table definition, independent of ensureMigrationsTable.
    // No application tables: any attempted replay must fail visibly.
    await db.exec(`
      CREATE TABLE __drizzle_migrations (
        id SERIAL PRIMARY KEY,
        hash TEXT NOT NULL UNIQUE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
      );
    `);
    const hashes = [
      ...migrationsManifest.migrations.map((migration) => migration.hash),
      ...shippedLedgerKeys,
      // Later additions are already applied in this replay fixture. The frozen
      // prefix above remains independent of the derived manifest.
      ...customMigrations.slice(shippedLedgerKeys.length).map((migration) => migration.hash),
    ];
    for (const hash of hashes) {
      await db.query('INSERT INTO __drizzle_migrations (hash) VALUES ($1)', [hash]);
    }
    const before = await db.query('SELECT * FROM __drizzle_migrations ORDER BY id');
    const onMigrationStart = vi.fn();
    const onMigrationComplete = vi.fn();

    await expect(runMigrations(db, { onMigrationComplete, onMigrationStart })).resolves.toEqual({
      appliedMigrations: [],
      success: true,
    });
    expect(onMigrationStart).not.toHaveBeenCalled();
    expect(onMigrationComplete).not.toHaveBeenCalled();
    expect((await db.query('SELECT * FROM __drizzle_migrations ORDER BY id')).rows).toEqual(
      before.rows
    );
  } finally {
    await db.close();
  }
});
