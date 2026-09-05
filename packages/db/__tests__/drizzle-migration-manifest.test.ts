import { afterEach, expect, it, vi } from 'vitest';
import type { Migration } from '../src/migrations/migration-runner.js';

// Reload module initialization so each test can supply a future numbered entry.
afterEach(() => {
  vi.resetModules();
});

it('automatically includes a new SQL migration registered only in the numbered manifest', async () => {
  const { migrations } = await import('../src/migrations/index.js');
  const migration: Migration = {
    ledgerKey: 'custom-116-manifest-test',
    name: 'manifest-test',
    up: 'SELECT 116;',
    version: 116,
  };
  migrations.push(migration);
  try {
    const { customMigrations } = await import('../src/drizzle/migrate.js');
    expect(customMigrations.at(-1)).toEqual({
      hash: migration.ledgerKey,
      name: migration.name,
      sql: migration.up,
      version: '116',
    });
  } finally {
    migrations.pop();
  }
});

it('throws at derivation time for an unfolded callback migration without executing it', async () => {
  const { migrations } = await import('../src/migrations/index.js');
  const up = vi.fn(async (): Promise<void> => {
    await Promise.resolve();
  });
  migrations.push({
    ledgerKey: 'custom-116-callback-test',
    name: 'callback-test',
    up,
    version: 116,
  });
  try {
    await expect(import('../src/drizzle/migrate.js')).rejects.toThrow(
      'Drizzle migration "callback-test" must be a SQL string.'
    );
    expect(up).not.toHaveBeenCalled();
  } finally {
    migrations.pop();
  }
});

it('throws at derivation time when a migration reuses a shipped ledger key', async () => {
  const { migrations } = await import('../src/migrations/index.js');
  // A new migration cloned from the previous one and left with its ledgerKey.
  migrations.push({
    ledgerKey: 'custom-115-mcp-task-authority',
    name: 'duplicate-key-test',
    up: 'SELECT 116;',
    version: 116,
  });
  try {
    await expect(import('../src/drizzle/migrate.js')).rejects.toThrow(
      'Drizzle migration "duplicate-key-test" reuses ledger key "custom-115-mcp-task-authority"'
    );
  } finally {
    migrations.pop();
  }
});
