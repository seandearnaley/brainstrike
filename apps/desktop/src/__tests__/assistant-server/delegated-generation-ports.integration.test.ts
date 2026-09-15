/**
 * ONE TURN, ONE LEDGER (BST-1749, PR #3198 review item 5; owner ruling
 * 2026-09-15). The host ports that carry a GENERATION across every leg of one
 * turn, over real rows: `recordNativeRootRun` (migration 140's native-run
 * mapping) and `readBackgroundGeneration`, plus the generation
 * `createThreadRun` derives for a leg that answers a decision.
 *
 * `initial-leg` opened this generation and `resume-leg` continues it;
 * `other-turn-leg` is a SECOND generation of the same root, and
 * `other-root-leg` belongs to another root entirely.
 */
import type { DelegatedConversationIdentity, DelegatedRunIdentity } from '@brainstrike/agent';
import { createPgliteAssistantThreadRepository } from '@brainstrike/assistant-data';
import { migrate, wasmLoader } from '@brainstrike/db';
import type { DbHandle } from '@brainstrike/db/react';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBudgetedHost } from './fixtures/budgeted-host';

describe('background generation ports (migration 140)', () => {
  let database: PGlite;
  const identity: DelegatedConversationIdentity = {
    childResourceId: 'native-child-owner',
    childThreadId: 'child',
    configuration: { maxSteps: 16, persona: { id: 'explore' } },
    parentResourceId: 'owner',
    parentRuntimeRunId: 'parent-native-run',
    parentThreadId: 'root',
    parentToolCallId: 'parent-call',
    personaId: 'explore',
  };
  const run: DelegatedRunIdentity = {
    childRuntimeRunId: 'child-native-run',
    parentRuntimeRunId: identity.parentRuntimeRunId,
    parentToolCallId: identity.parentToolCallId,
    personaId: identity.personaId,
  };

  beforeEach(async () => {
    database = await wasmLoader.createPGlite('memory://delegated-generation-ports');
    await migrate(database);
    await database.exec(`INSERT INTO mastra_threads
      (id, "resourceId", title, metadata, "createdAt", "updatedAt") VALUES
      ('root', 'owner', 'Root', '{}', NOW(), NOW()),
      ('other', 'owner', 'Other root', '{}', NOW(), NOW()),
      ('child', 'native-child-owner', 'Child', '{}', NOW(), NOW());
      INSERT INTO brainstrike_assistant_thread_runs
      (id, resource_id, thread_id, provider, model, runtime_kind, status,
       started_at, created_at, updated_at, turn_message_id, generation_run_id) VALUES
      ('initial-leg', 'owner', 'root', 'openai', 'test', 'desktop', 'running',
       NOW(), NOW(), NOW(), 'user-turn', 'initial-leg'),
      ('resume-leg', 'owner', 'root', 'openai', 'test', 'desktop', 'running',
       NOW(), NOW(), NOW(), 'user-turn', 'initial-leg'),
      ('other-turn-leg', 'owner', 'root', 'openai', 'test', 'desktop', 'running',
       NOW(), NOW(), NOW(), 'other-turn', 'other-turn-leg'),
      ('other-root-leg', 'owner', 'other', 'openai', 'test', 'desktop', 'running',
       NOW(), NOW(), NOW(), 'user-turn', 'other-root-leg');`);
  }, 30_000);

  afterEach(async () => {
    await database.close();
  });

  const hostFor = (id: string) => createBudgetedHost(database, id);
  const newLeg = async (
    id: string,
    decision: { delegated: boolean; runId: string; toolCallId: string }
  ) => {
    await createPgliteAssistantThreadRepository(database as DbHandle).createThreadRun({
      decision,
      id,
      model: 'test',
      provider: 'openai',
      resourceId: 'owner',
      runtimeKind: 'local',
      threadId: 'root',
      turnMessageId: 'user-turn',
    });
    return hostFor(id);
  };

  it('maps native root runs and reports one generation to every leg of it', async () => {
    await hostFor('initial-leg').recordNativeRootRun('native-first');
    await hostFor('resume-leg').recordNativeRootRun('native-continuation');
    const expected = {
      generationRunId: 'initial-leg',
      nativeRunIds: ['native-first', 'native-continuation'],
    };
    expect(await hostFor('initial-leg').readBackgroundGeneration()).toEqual(expected);
    expect(await hostFor('resume-leg').readBackgroundGeneration()).toEqual(expected);
  });

  it('keeps the first writer and refuses to re-parent a run into another generation', async () => {
    // An approval leg re-streams the very run it resumed, so the mapping is
    // idempotent within a generation; another generation claiming it is an
    // invariant break, never a silent re-parent.
    await hostFor('initial-leg').recordNativeRootRun('native-first');
    await hostFor('resume-leg').recordNativeRootRun('native-first');
    expect(
      (
        await database.query(
          'SELECT host_run_id FROM brainstrike_assistant_native_runs WHERE native_run_id = $1',
          ['native-first']
        )
      ).rows
    ).toEqual([{ host_run_id: 'initial-leg' }]);
    await expect(hostFor('other-turn-leg').recordNativeRootRun('native-first')).rejects.toThrow();
  });

  it("never counts another generation's or another root's mapped runs", async () => {
    await hostFor('initial-leg').recordNativeRootRun('native-first');
    await hostFor('other-turn-leg').recordNativeRootRun('native-other-turn');
    await hostFor('other-root-leg').recordNativeRootRun('native-other-root');
    expect(await hostFor('resume-leg').readBackgroundGeneration()).toEqual({
      generationRunId: 'initial-leg',
      nativeRunIds: ['native-first'],
    });
  });

  it('a leg answering a DELEGATED pause inherits the generation of the dispatching leg', async () => {
    const host = hostFor('initial-leg');
    await host.persist(identity);
    await host.bindRun(run);
    const approval = await newLeg('approval-leg', {
      delegated: true,
      runId: identity.parentRuntimeRunId,
      toolCallId: identity.parentToolCallId,
    });
    expect(await approval.readBackgroundGeneration()).toEqual({
      generationRunId: 'initial-leg',
      nativeRunIds: [],
    });
  });

  it('a leg answering a ROOT-OWN pause inherits through the native run the host mapped', async () => {
    // No delegation ancestry to follow: the generation comes from the run
    // mapping alone, which is why the mapping table exists at all.
    await hostFor('initial-leg').recordNativeRootRun('native-root-pause');
    const approval = await newLeg('root-approval-leg', {
      delegated: false,
      runId: 'native-root-pause',
      toolCallId: 'root-write',
    });
    expect(await approval.readBackgroundGeneration()).toEqual({
      generationRunId: 'initial-leg',
      nativeRunIds: ['native-root-pause'],
    });
  });

  it('leaves the generation unset when nothing maps the decision run, and refuses to invent one', async () => {
    // A pause parked before migration 140 has no mapping: the ledger fails
    // loudly rather than publish under an identity no other leg shares.
    const orphan = await newLeg('orphan-leg', {
      delegated: false,
      runId: 'never-mapped-run',
      toolCallId: 'root-write',
    });
    expect(
      (
        await database.query<{ generationRunId: string | null }>(
          'SELECT generation_run_id AS "generationRunId" FROM brainstrike_assistant_thread_runs WHERE id = $1',
          ['orphan-leg']
        )
      ).rows
    ).toEqual([{ generationRunId: null }]);
    await expect(orphan.readBackgroundGeneration()).rejects.toThrow();
  });
});
