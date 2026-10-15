/**
 * BST-1163: the stored run↔turn-message link. `createThreadRun` persists
 * `turn_message_id` — the id of the user message whose turn the run belongs
 * to — so rewind range resolution stops relying on timestamp rules that
 * cannot separate a resume of turn N from the opening run of turn N+1.
 *
 * Real PGlite, real bootstrap (no mocks): also proves the idempotent
 * `ALTER TABLE … ADD COLUMN IF NOT EXISTS` upgrade path for installs whose
 * runs table predates the column (renderer-bootstrapped schema — there is
 * deliberately NO numbered migration for this table; see
 * docs/agents/assistant-persistence.md § "Canonical history and live
 * output").
 */
import type { HostRunId } from '@brainstrike/assistant-contract/host-run-id';
import { migrate } from '@brainstrike/db';
import type { DbHandle } from '@brainstrike/db/react';
import { describe, expect, it } from 'vitest';
import { createPgliteAssistantThreadRepository } from '../assistant-memory-repository';
import { createMigratedTestPGlite, createTestPGlite } from './helpers/test-pglite';

let pgliteDataDirCounter = 0;

function createPgliteTestDataDir(prefix: string): string {
  pgliteDataDirCounter += 1;
  return `memory://${prefix}-${pgliteDataDirCounter}`;
}

describe('assistant thread run turn link (real PGlite, BST-1163)', () => {
  let pgliteDataDir: string | undefined;

  it('persists turnMessageId at run creation and returns it on the record', async () => {
    pgliteDataDir = createPgliteTestDataDir('run-turn-link');
    const db = await createMigratedTestPGlite(pgliteDataDir);
    const repository = createPgliteAssistantThreadRepository(db as DbHandle);
    const thread = await repository.createThread('workspace-a');

    const record = await repository.createThreadRun({
      id: 'run-1' as HostRunId,
      model: 'claude-sonnet-5',
      provider: 'anthropic',
      resourceId: 'workspace-a',
      runtimeKind: 'hosted',
      threadId: thread.id,
      turnMessageId: 'msg-user-1',
    });
    expect(record.turnMessageId).toBe('msg-user-1');

    const row = await db.query<{ turnMessageId: string | null }>(
      'SELECT turn_message_id AS "turnMessageId" FROM brainstrike_assistant_thread_runs WHERE id = $1',
      ['run-1']
    );
    expect(row.rows[0]?.turnMessageId).toBe('msg-user-1');
  });

  it('persists NULL when no turn message id is in hand (legacy/edge callers)', async () => {
    pgliteDataDir = createPgliteTestDataDir('run-turn-link-null');
    const db = await createMigratedTestPGlite(pgliteDataDir);
    const repository = createPgliteAssistantThreadRepository(db as DbHandle);
    const thread = await repository.createThread('workspace-a');

    const record = await repository.createThreadRun({
      id: 'run-1' as HostRunId,
      model: 'claude-sonnet-5',
      provider: 'anthropic',
      resourceId: 'workspace-a',
      runtimeKind: 'hosted',
      threadId: thread.id,
    });
    expect(record.turnMessageId).toBeNull();

    const row = await db.query<{ turnMessageId: string | null }>(
      'SELECT turn_message_id AS "turnMessageId" FROM brainstrike_assistant_thread_runs WHERE id = $1',
      ['run-1']
    );
    expect(row.rows[0]?.turnMessageId).toBeNull();
  });

  it('upgrades a pre-1163 runs table in place (migration 118 ADD COLUMN IF NOT EXISTS)', async () => {
    pgliteDataDir = createPgliteTestDataDir('run-turn-link-upgrade');
    // Start from the state a real pre-1163 install is in: the runs table
    // already exists (the retired renderer bootstrap created it), so migration
    // 118's `CREATE TABLE IF NOT EXISTS` no-ops and its `ALTER … ADD COLUMN IF
    // NOT EXISTS` is that install's ONLY path to the column. Before BST-1651
    // the bootstrap re-ran the ALTER on every handle init; it no longer runs at
    // all, which is precisely why the statement had to move into the migration.
    const db = await createTestPGlite(pgliteDataDir);
    // The exact pre-1163 column set (FK omitted: the upgrade path under test
    // is the ALTER, which is FK-independent; a real old install's FK is
    // untouched by it).
    await db.exec(`
      CREATE TABLE brainstrike_assistant_thread_runs (
        id text PRIMARY KEY,
        resource_id text NOT NULL,
        thread_id text NOT NULL,
        provider text NOT NULL,
        model text NOT NULL,
        model_settings jsonb,
        provider_options jsonb,
        runtime_kind text NOT NULL,
        status text NOT NULL,
        error text,
        started_at timestamptz NOT NULL,
        completed_at timestamptz,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
    `);
    await migrate(db);

    const repository = createPgliteAssistantThreadRepository(db as DbHandle);
    const thread = await repository.createThread('workspace-a');
    const record = await repository.createThreadRun({
      id: 'run-upgraded' as HostRunId,
      model: 'claude-sonnet-5',
      provider: 'anthropic',
      resourceId: 'workspace-a',
      runtimeKind: 'hosted',
      threadId: thread.id,
      turnMessageId: 'msg-user-9',
    });
    expect(record.turnMessageId).toBe('msg-user-9');

    const row = await db.query<{ turnMessageId: string | null }>(
      'SELECT turn_message_id AS "turnMessageId" FROM brainstrike_assistant_thread_runs WHERE id = $1',
      ['run-upgraded']
    );
    expect(row.rows[0]?.turnMessageId).toBe('msg-user-9');
  });
});
