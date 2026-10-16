/**
 * BST-1163: the stored run↔turn-message link. `createThreadRun` persists
 * `turn_message_id` — the id of the user message whose turn the run belongs
 * to — so rewind range resolution stops relying on timestamp rules that
 * cannot separate a resume of turn N from the opening run of turn N+1.
 *
 * Real PGlite, real migration (no mocks), against the schema a fresh profile
 * initializes: `current-schema-ddl.ts` creates the runs table WITH the column.
 * There is no populated-old-schema upgrade case here — ADR-0020 (greenfield
 * data lifecycle) puts "populated old-schema upgrade qualification" on the
 * do-not-implement list, and the `ALTER TABLE … ADD COLUMN IF NOT EXISTS`
 * path such a case would exercise no longer exists in `packages/db`.
 */
import type { HostRunId } from '@brainstrike/assistant-contract/host-run-id';
import type { DbHandle } from '@brainstrike/db/react';
import { describe, expect, it } from 'vitest';
import { createPgliteAssistantThreadRepository } from '../assistant-memory-repository';
import { createMigratedTestPGlite } from './helpers/test-pglite';

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
});
