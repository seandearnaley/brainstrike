import type { DelegatedConversationIdentity, DelegatedRunIdentity } from '@brainstrike/agent';
import { migrate, wasmLoader } from '@brainstrike/db';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  completeDelegatedConversationCancellation,
  revokeDelegatedConversationAdmission,
} from '../../assistant-server/delegated-cancellation-admission';
import { createDesktopDelegatedConversationHost } from '../../assistant-server/delegated-conversation-host';
import { readDelegatedDecisionStates } from '../../assistant-server/delegated-decision-discovery';

describe('desktop delegated cancellation', () => {
  let database: PGlite;
  const scope = { ownerResourceId: 'owner', rootThreadId: 'root' };
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
    database = await wasmLoader.createPGlite('memory://delegated-host');
    await migrate(database);
    await database.exec(`INSERT INTO mastra_threads
      (id, "resourceId", title, metadata, "createdAt", "updatedAt") VALUES
      ('root', 'owner', 'Root', '{}', NOW(), NOW()),
      ('other', 'owner', 'Other root', '{}', NOW(), NOW()),
      ('child', 'native-child-owner', 'Child', '{}', NOW(), NOW()),
      ('sibling', 'native-sibling-owner', 'Sibling', '{}', NOW(), NOW());
      INSERT INTO brainstrike_assistant_thread_runs
      (id, resource_id, thread_id, provider, model, runtime_kind, status,
       started_at, created_at, updated_at, turn_message_id) VALUES
      ('initial-leg', 'owner', 'root', 'openai', 'test', 'desktop', 'running',
       NOW(), NOW(), NOW(), 'user-turn'),
      ('resume-leg', 'owner', 'root', 'openai', 'test', 'desktop', 'running',
       NOW(), NOW(), NOW(), 'user-turn'),
      ('other-turn-leg', 'owner', 'root', 'openai', 'test', 'desktop', 'running',
       NOW(), NOW(), NOW(), 'other-turn'),
      ('other-root-leg', 'owner', 'other', 'openai', 'test', 'desktop', 'running',
       NOW(), NOW(), NOW(), 'user-turn');`);
  }, 30_000);

  afterEach(async () => {
    await database.close();
  });

  const childStarted = {
    id: 'child-start',
    kind: 'run.started',
    label: 'Child started',
    status: 'running',
    timestamp: '2026-09-10T01:00:00.000Z',
  } as const;
  it('settles stopped child projections once while preserving sibling and completed runs', async () => {
    const host = createDesktopDelegatedConversationHost(database, 'initial-leg');
    await host.persist(identity);
    await host.bindRun(run);
    const event = await host.persistEvent(run, 'child-message', childStarted, 0);
    const sibling = {
      ...identity,
      childResourceId: 'native-sibling-owner',
      childThreadId: 'sibling',
      parentToolCallId: 'sibling-call',
    };
    const siblingRun = {
      ...run,
      childRuntimeRunId: 'sibling-run',
      parentToolCallId: 'sibling-call',
    };
    await host.persist(sibling);
    await host.bindRun(siblingRun);
    const other = await host.persistEvent(
      siblingRun,
      'sibling-message',
      { ...childStarted, id: 'sibling-start' },
      0
    );
    const completed = await createDesktopDelegatedConversationHost(
      database,
      'resume-leg'
    ).persistEvent(
      run,
      'completed-message',
      { ...childStarted, id: 'child-finished', kind: 'run.finished', status: 'completed' },
      1
    );
    const targets = await revokeDelegatedConversationAdmission(
      database,
      scope,
      identity.childThreadId,
      false
    );
    await completeDelegatedConversationCancellation(database, scope, targets);
    await completeDelegatedConversationCancellation(database, scope, targets);
    const rows = await database.query<Record<string, unknown>>(
      'SELECT id, status, completed_at FROM brainstrike_assistant_thread_runs WHERE id = ANY($1::text[]) ORDER BY id',
      [[event.runId, other.runId, completed.runId]]
    );
    expect(rows.rows.find((row) => row['id'] === event.runId)).toMatchObject({
      completed_at: expect.any(Date),
      status: 'cancelled',
    });
    expect(rows.rows.find((row) => row['id'] === other.runId)).toMatchObject({
      completed_at: null,
      status: 'running',
    });
    expect(rows.rows.find((row) => row['id'] === completed.runId)).toMatchObject({
      status: 'completed',
    });
    const terminal = await database.query<{ metadata: unknown }>(
      "SELECT kind, metadata FROM brainstrike_assistant_run_events WHERE run_id = $1 AND kind = 'run.cancelled'",
      [event.runId]
    );
    expect(terminal.rows).toHaveLength(1);
    expect(terminal.rows[0]?.['metadata']).toMatchObject({ nativeMessageId: 'child-message' });
  });

  it.each([false, true])(
    'revokes only the selected invocation scope (descendants: %s)',
    async (includeDescendants) => {
      const host = createDesktopDelegatedConversationHost(database, 'initial-leg');
      await host.persist(identity);
      await host.bindRun(run);
      const descendant = {
        ...identity,
        childResourceId: 'native-sibling-owner',
        childThreadId: 'sibling',
        parentResourceId: identity.childResourceId,
        parentRuntimeRunId: run.childRuntimeRunId,
        parentThreadId: identity.childThreadId,
        parentToolCallId: 'grandchild-call',
      };
      await host.persist(descendant);
      await host.bindRun({
        ...run,
        childRuntimeRunId: 'grandchild-run',
        parentRuntimeRunId: run.childRuntimeRunId,
        parentToolCallId: 'grandchild-call',
      });
      const targets = await revokeDelegatedConversationAdmission(
        database,
        scope,
        identity.childThreadId,
        includeDescendants
      );
      expect(targets.map((target) => target.threadId).sort()).toEqual(
        includeDescendants ? ['child', 'sibling'] : ['child']
      );
      const first = await database.query(
        'SELECT thread_id, cancellation_requested_at FROM brainstrike_delegated_invocations ORDER BY thread_id'
      );
      await revokeDelegatedConversationAdmission(
        database,
        scope,
        identity.childThreadId,
        includeDescendants
      );
      expect(
        (
          await database.query(
            'SELECT thread_id, cancellation_requested_at FROM brainstrike_delegated_invocations ORDER BY thread_id'
          )
        ).rows
      ).toEqual(first.rows);
      await expect(
        host.budget.reserveStep({
          resourceId: descendant.childResourceId,
          threadId: descendant.childThreadId,
        })
      ).rejects.toThrow();
      await expect(host.persist(descendant)).rejects.toThrow();
    }
  );

  it('rejects a stopped child decision after host reconstruction while admitting its sibling', async () => {
    const host = createDesktopDelegatedConversationHost(database, 'initial-leg');
    await host.persist(identity);
    await host.bindRun(run);
    const siblingIdentity = {
      ...identity,
      childResourceId: 'native-sibling-owner',
      childThreadId: 'sibling',
      parentToolCallId: 'sibling-call',
    };
    const siblingRun = {
      ...run,
      childRuntimeRunId: 'sibling-run',
      parentToolCallId: 'sibling-call',
    };
    await host.persist(siblingIdentity);
    await host.bindRun(siblingRun);
    await expect(
      revokeDelegatedConversationAdmission(
        database,
        { ...scope, rootThreadId: 'other' },
        identity.childThreadId,
        false
      )
    ).rejects.toThrow();
    await expect(
      revokeDelegatedConversationAdmission(database, scope, scope.rootThreadId, false)
    ).rejects.toThrow();
    expect(
      await revokeDelegatedConversationAdmission(database, scope, identity.childThreadId, false)
    ).toEqual([
      {
        childRuntimeRunId: run.childRuntimeRunId,
        parentRuntimeRunId: run.parentRuntimeRunId,
        parentToolCallId: run.parentToolCallId,
        threadId: identity.childThreadId,
      },
    ]);
    expect(
      await readDelegatedDecisionStates(database, scope, [
        {
          delegation: { path: [run], toolCallId: 'read-1' },
          runId: run.parentRuntimeRunId,
          toolCallId: run.parentToolCallId,
        },
      ])
    ).toEqual(new Map([[JSON.stringify([run.childRuntimeRunId, 'read-1']), 'cancelled']]));
    const restored = createDesktopDelegatedConversationHost(database, 'resume-leg');
    await expect(
      restored.budget.reserveStep({
        resourceId: identity.childResourceId,
        threadId: identity.childThreadId,
      })
    ).rejects.toThrow();
    await expect(restored.persist(identity)).rejects.toThrow();
    await expect(
      restored.claimToolAction({
        delegation: { path: [run], toolCallId: 'read-1' },
        runId: run.parentRuntimeRunId,
        toolCallId: run.parentToolCallId,
      })
    ).rejects.toThrow();
    await restored.claimToolAction({
      delegation: { path: [siblingRun], toolCallId: 'read-1' },
      runId: siblingRun.parentRuntimeRunId,
      toolCallId: siblingRun.parentToolCallId,
    });
    await restored.finishToolActions();
    const rows = await database.query<Record<string, unknown>>(
      'SELECT child_thread_id, state FROM brainstrike_delegated_tool_decisions'
    );
    expect(rows.rows).toEqual([{ child_thread_id: 'sibling', state: 'consumed' }]);
  });
});
