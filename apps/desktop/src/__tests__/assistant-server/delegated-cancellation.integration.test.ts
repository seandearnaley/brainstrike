import type {
  DelegatedConversationIdentity,
  DelegatedFollowupControl,
  DelegatedRunIdentity,
} from '@brainstrike/agent';
import { migrate, wasmLoader } from '@brainstrike/db';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  completeDelegatedConversationCancellation,
  revokeDelegatedConversationAdmission,
} from '../../assistant-server/delegated-cancellation-admission';
import { createDesktopDelegatedConversationHost } from '../../assistant-server/delegated-conversation-host';
import { readDelegatedDecisionStates } from '../../assistant-server/delegated-decision-discovery';
import {
  joinDesktopDelegatedCancellation,
  registerDesktopDelegatedCancellation,
} from '../../assistant-server/delegated-execution-controls';

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
  it('authorizes human input only for the observed child in its owning live host', async () => {
    const host = createDesktopDelegatedConversationHost(database, 'initial-leg');
    const send = vi.fn(async () => {});
    const input = { id: 'human-input', text: 'Inspect the second file' };
    await host.persist(identity);
    await expect(host.sendFollowup(scope, 'child', input, send)).rejects.toThrow();
    await host.bindRun(run);
    await expect(
      host.sendFollowup({ ...scope, rootThreadId: 'other' }, 'child', input, send)
    ).rejects.toThrow();
    await expect(
      host.sendFollowup({ ...scope, ownerResourceId: 'stranger' }, 'child', input, send)
    ).rejects.toThrow();
    await expect(host.sendFollowup(scope, 'sibling', input, send)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    await host.sendFollowup(scope, 'child', input, send);
    expect(send).toHaveBeenCalledExactlyOnceWith(
      {
        identity: run,
        personaId: 'explore',
        resourceId: identity.childResourceId,
        runId: run.childRuntimeRunId,
        threadId: 'child',
      },
      input,
      expect.any(Function),
      undefined
    );
    await revokeDelegatedConversationAdmission(database, scope, 'child', false);
    await expect(
      host.sendFollowup(scope, 'child', { ...input, id: 'after-stop' }, send)
    ).rejects.toThrow();
    expect(send).toHaveBeenCalledOnce();
  });

  it('rejects a follow-up queued before durable Stop when its serialized admission resumes', async () => {
    const host = createDesktopDelegatedConversationHost(database, 'initial-leg');
    await host.persist(identity);
    await host.bindRun(run);
    const queued = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const delivered = vi.fn();
    const send: DelegatedFollowupControl = async (_target, _input, assertAdmission) => {
      queued.resolve();
      await release.promise;
      await assertAdmission();
      delivered();
    };
    const pending = host.sendFollowup(
      scope,
      'child',
      { id: 'queued', text: 'Do not deliver after Stop' },
      send
    );
    pending.catch(() => {});
    try {
      await queued.promise;
      await revokeDelegatedConversationAdmission(database, scope, 'child', false);
      release.resolve();
      await expect(pending).rejects.toThrow();
      expect(delivered).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await Promise.allSettled([pending]);
    }
  });

  it('joins registered owners in the selected root and propagates cleanup failure', async () => {
    const release = Promise.withResolvers<void>();
    const first = vi.fn(async () => {
      await release.promise;
    });
    const failure = new Error('Native cleanup failed');
    const second = vi.fn(async () => {
      throw failure;
    });
    const otherRoot = vi.fn(async () => undefined);
    const unregister = [
      registerDesktopDelegatedCancellation('initial-leg', first),
      registerDesktopDelegatedCancellation('resume-leg', second),
      registerDesktopDelegatedCancellation('other-root-leg', otherRoot),
    ];
    let joined: Promise<void> | undefined;
    try {
      joined = joinDesktopDelegatedCancellation(database, scope, []);
      const assertion = expect(joined).rejects.toMatchObject({ errors: [failure] });
      await vi.waitFor(() => expect(first).toHaveBeenCalledOnce());
      expect(otherRoot).not.toHaveBeenCalled();
      release.resolve();
      await assertion;
      expect(second).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await Promise.allSettled([joined]);
      for (const dispose of unregister) {
        dispose();
      }
    }
    await expect(joinDesktopDelegatedCancellation(database, scope, [])).resolves.toBeUndefined();
  });
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

  it('stops every admitted leg of the selected conversation without duplicating terminal events', async () => {
    const ids: string[] = [];
    for (const [hostId, parentRuntimeRunId] of [
      ['initial-leg', 'parent-one'],
      ['other-turn-leg', 'parent-two'],
    ] as const) {
      const host = createDesktopDelegatedConversationHost(database, hostId);
      await host.persist({ ...identity, parentRuntimeRunId });
      const childRun = {
        ...run,
        childRuntimeRunId: `${parentRuntimeRunId}-child`,
        parentRuntimeRunId,
      };
      await host.bindRun(childRun);
      const event = await host.persistEvent(
        childRun,
        `${parentRuntimeRunId}-message`,
        { ...childStarted, id: `${parentRuntimeRunId}-started` },
        0
      );
      if (!event.runId) {
        throw new Error('Missing child host run');
      }
      ids.push(event.runId);
    }
    const targets = await revokeDelegatedConversationAdmission(database, scope, 'child', false);
    expect(targets).toHaveLength(2);
    await completeDelegatedConversationCancellation(database, scope, targets);
    await completeDelegatedConversationCancellation(database, scope, targets);
    const result = await database.query<{ run_id: string; count: number }>(
      "SELECT run_id, COUNT(*)::int AS count FROM brainstrike_assistant_run_events WHERE run_id = ANY($1::text[]) AND kind = 'run.cancelled' GROUP BY run_id",
      [ids]
    );
    expect(result.rows).toHaveLength(2);
    expect(result.rows.every((row) => row.count === 1)).toBe(true);
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
