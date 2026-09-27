import type { DelegatedRunIdentity, StreamChunk } from '@brainstrike/agent';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  completeFailedRootRun,
  settleFailedDelegationChildRuns,
} from '../../assistant-server/delegated-stream-failure';
import { observeDesktopAssistantRunEvents } from '../../assistant-server/run-persistence';
import { DbHostRequestTimeoutError } from '../../db-host-manager';
import { createBudgetedHost } from './fixtures/budgeted-host';
import { createHostDatabase } from './fixtures/delegated-host-fixtures';

describe('failed stream native cancellation reconciliation', () => {
  let database: PGlite;
  beforeEach(async () => {
    database = await createHostDatabase('memory://stream-failure');
  });
  afterEach(async () => {
    await database.close();
  });

  async function child(
    name: string,
    options: {
      hostLeg?: string;
      nativeStatus?: string;
      completed?: boolean;
      parent?: { threadId: string; resourceId: string; runId: string };
    } = {}
  ): Promise<{ runId: string; identity: DelegatedRunIdentity }> {
    const hostLeg = options.hostLeg ?? 'initial-leg';
    const root = hostLeg === 'other-root-leg' ? 'other' : 'root';
    const parent = options.parent ?? {
      resourceId: 'owner',
      runId: `${hostLeg}-native`,
      threadId: root,
    };
    await database.query(
      `INSERT INTO mastra_threads (id,"resourceId",title,metadata,"createdAt","updatedAt") VALUES ($1,$2,$1,'{}',NOW(),NOW())`,
      [name, `${name}-owner`]
    );
    const host = createBudgetedHost(database, hostLeg);
    const identity = {
      childRuntimeRunId: `${name}-native`,
      parentRuntimeRunId: parent.runId,
      parentToolCallId: name,
      personaId: 'explore',
    };
    await host.persist({
      ...identity,
      childResourceId: `${name}-owner`,
      childThreadId: name,
      configuration: { maxSteps: 8, persona: { id: 'explore' } },
      parentResourceId: parent.resourceId,
      parentThreadId: parent.threadId,
    });
    await host.bindRun(identity);
    const event = await host.persistEvent(
      identity,
      `${name}-message`,
      {
        id: `${name}-start`,
        kind: 'run.started',
        label: 'Started',
        status: 'running',
        timestamp: '2026-09-17T00:00:00Z',
      },
      0
    );
    if (options.completed) {
      await host.persistEvent(
        identity,
        `${name}-message`,
        {
          id: `${name}-finish`,
          kind: 'run.finished',
          label: 'Completed',
          status: 'completed',
          timestamp: '2026-09-17T00:00:01Z',
        },
        1
      );
    }
    if (!options.parent || options.nativeStatus) {
      await database.query(
        `INSERT INTO mastra_background_tasks (id,tool_call_id,tool_name,agent_id,run_id,thread_id,resource_id,status,args,retry_count,max_retries,timeout_ms,"createdAt") VALUES ($1,$1,'agent-explore','parent',$2,$3,$4,$5,'{}',0,0,30000,NOW())`,
        [
          name,
          parent.runId,
          parent.threadId,
          parent.resourceId,
          options.nativeStatus ?? 'cancelled',
        ]
      );
    }
    if (!event.runId) {
      throw new Error('Missing child host run');
    }
    return { identity, runId: event.runId };
  }

  async function reportFailedInvocation(
    identity: DelegatedRunIdentity,
    eventId: string
  ): Promise<void> {
    await database.query(
      `INSERT INTO brainstrike_assistant_run_events
       (id,run_id,resource_id,thread_id,sequence,kind,status,label,metadata,occurred_at,created_at,updated_at)
       VALUES ($1,'resume-leg','owner','root',0,'subagent.failed','failed','Subagent failed',$2::jsonb,NOW(),NOW(),NOW())`,
      [
        eventId,
        JSON.stringify({
          parentRuntimeRunId: identity.parentRuntimeRunId,
          parentToolCallId: identity.parentToolCallId,
          personaId: identity.personaId,
        }),
      ]
    );
  }

  it('settles only cancelled native invocation trees once, preserving parked, active, completed and unrelated work', async () => {
    const cancelled = await child('cancelled');
    await child('nested', {
      parent: {
        resourceId: 'cancelled-owner',
        runId: cancelled.identity.childRuntimeRunId,
        threadId: 'cancelled',
      },
    });
    await child('nested-active', {
      nativeStatus: 'running',
      parent: {
        resourceId: 'cancelled-owner',
        runId: cancelled.identity.childRuntimeRunId,
        threadId: 'cancelled',
      },
    });
    await child('nested-parked', {
      nativeStatus: 'suspended',
      parent: {
        resourceId: 'cancelled-owner',
        runId: cancelled.identity.childRuntimeRunId,
        threadId: 'cancelled',
      },
    });
    await child('parked', { nativeStatus: 'suspended' });
    await child('active', { nativeStatus: 'running' });
    await child('completed', { completed: true });
    await child('older-turn', { hostLeg: 'other-turn-leg' });
    await child('another-root', { hostLeg: 'other-root-leg' });
    await child('changed-owner');
    await database.query('UPDATE mastra_threads SET "resourceId"=$1 WHERE id=$2', [
      'different-owner',
      'changed-owner',
    ]);
    await completeFailedRootRun(database, 'initial-leg', 'usage-binding-conflict');
    await completeFailedRootRun(database, 'initial-leg', 'usage-binding-conflict');
    expect(
      (
        await database.query(
          "SELECT thread_id,status FROM brainstrike_assistant_thread_runs WHERE thread_id NOT IN ('root','other') ORDER BY thread_id"
        )
      ).rows
    ).toEqual([
      { status: 'running', thread_id: 'active' },
      { status: 'running', thread_id: 'another-root' },
      { status: 'cancelled', thread_id: 'cancelled' },
      { status: 'running', thread_id: 'changed-owner' },
      { status: 'completed', thread_id: 'completed' },
      { status: 'cancelled', thread_id: 'nested' },
      { status: 'running', thread_id: 'nested-active' },
      { status: 'running', thread_id: 'nested-parked' },
      { status: 'running', thread_id: 'older-turn' },
      { status: 'running', thread_id: 'parked' },
    ]);
    expect(
      (
        await database.query(
          "SELECT thread_id,kind FROM brainstrike_assistant_run_events WHERE kind='run.cancelled' ORDER BY thread_id"
        )
      ).rows
    ).toEqual([
      { kind: 'run.cancelled', thread_id: 'cancelled' },
      { kind: 'run.cancelled', thread_id: 'nested' },
    ]);
    expect(
      (
        await database.query(
          "SELECT id,status,error FROM brainstrike_assistant_thread_runs WHERE thread_id IN ('root','other') ORDER BY id"
        )
      ).rows
    ).toEqual([
      { error: 'usage-binding-conflict', id: 'initial-leg', status: 'failed' },
      { error: null, id: 'other-root-leg', status: 'running' },
      { error: null, id: 'other-turn-leg', status: 'running' },
      { error: null, id: 'resume-leg', status: 'running' },
    ]);
  });

  it('records the original failure when the root has no delegated children', async () => {
    await completeFailedRootRun(database, 'initial-leg', 'nope-blocked');
    expect(
      (
        await database.query(
          "SELECT status,error FROM brainstrike_assistant_thread_runs WHERE id='initial-leg'"
        )
      ).rows
    ).toEqual([{ error: 'nope-blocked', status: 'failed' }]);
    expect((await database.query('SELECT id FROM brainstrike_assistant_run_events')).rows).toEqual(
      []
    );
  });

  it('settles failed native tasks when the parent reports failure, across child host legs only', async () => {
    const failed = await child('failed', { nativeStatus: 'failed' });
    await database.query('UPDATE mastra_background_tasks SET error=$1::jsonb WHERE id=$2', [
      JSON.stringify({ message: 'No executor registered', name: 'Error' }),
      'failed',
    ]);
    const resumedEvent = await createBudgetedHost(database, 'resume-leg').persistEvent(
      failed.identity,
      'failed-resume-message',
      {
        id: 'failed-resume-start',
        kind: 'run.started',
        label: 'Started',
        status: 'running',
        timestamp: '2026-09-17T00:00:00Z',
      },
      0
    );
    if (!resumedEvent.runId) {
      throw new Error('Missing resumed child host run');
    }
    const running = await child('running', { nativeStatus: 'running' });
    const suspended = await child('suspended', { nativeStatus: 'suspended' });
    const completed = await child('completed', { completed: true, nativeStatus: 'completed' });
    const otherTurn = await child('other-turn', {
      hostLeg: 'other-turn-leg',
      nativeStatus: 'failed',
    });
    const otherRoot = await child('other-root', {
      hostLeg: 'other-root-leg',
      nativeStatus: 'failed',
    });
    const failedEvent = {
      id: 'parent-failed',
      kind: 'subagent.failed',
      label: 'Subagent failed',
      metadata: {
        parentRuntimeRunId: failed.identity.parentRuntimeRunId,
        parentToolCallId: failed.identity.parentToolCallId,
        personaId: failed.identity.personaId,
      },
      status: 'failed',
      timestamp: '2026-09-17T00:00:02Z',
    } as const;
    async function* source() {
      yield { event: failedEvent, type: 'run-event' as const };
    }
    for await (const chunk of observeDesktopAssistantRunEvents(
      source(),
      'resume-leg',
      [],
      async () => database
    )) {
      if (chunk.type === 'run-event') {
        const settled = await database.query(
          'SELECT status FROM brainstrike_assistant_thread_runs WHERE id = $1',
          [failed.runId]
        );
        expect(settled.rows).toEqual([{ status: 'failed' }]);
      }
    }
    await settleFailedDelegationChildRuns(database, 'resume-leg', 'parent-failed');
    const statuses = await database.query(
      `SELECT id,status FROM brainstrike_assistant_thread_runs WHERE thread_id NOT IN ('root','other') ORDER BY id`
    );
    expect(statuses.rows).toContainEqual({ id: failed.runId, status: 'failed' });
    expect(statuses.rows).toContainEqual({ id: resumedEvent.runId, status: 'failed' });
    for (const survivor of [running, suspended, completed, otherTurn, otherRoot]) {
      expect(statuses.rows).toContainEqual({
        id: survivor.runId,
        status: survivor === completed ? 'completed' : 'running',
      });
    }
    expect(
      (
        await database.query(
          `SELECT run_id,kind FROM brainstrike_assistant_run_events WHERE id LIKE '%:background-task-terminal' ORDER BY run_id`
        )
      ).rows
    ).toEqual(
      [
        { kind: 'run.failed', run_id: failed.runId },
        { kind: 'run.failed', run_id: resumedEvent.runId },
      ].sort((left, right) => left.run_id.localeCompare(right.run_id))
    );
    expect(
      (
        await database.query(
          'SELECT error FROM brainstrike_assistant_thread_runs WHERE id IN ($1,$2) ORDER BY id',
          [failed.runId, resumedEvent.runId]
        )
      ).rows
    ).toEqual([{ error: 'No executor registered' }, { error: 'No executor registered' }]);
    expect(
      (
        await database.query(
          "SELECT detail FROM brainstrike_assistant_run_events WHERE id LIKE '%:background-task-terminal' ORDER BY run_id"
        )
      ).rows
    ).toEqual([{ detail: 'No executor registered' }, { detail: 'No executor registered' }]);
  });

  it('keeps a native cancellation distinct from a task failure', async () => {
    const cancelled = await child('cancelled-task', { nativeStatus: 'cancelled' });
    await database.query(
      `INSERT INTO brainstrike_assistant_run_events
       (id,run_id,resource_id,thread_id,sequence,kind,status,label,metadata,occurred_at,created_at,updated_at)
       VALUES ('parent-cancelled','resume-leg','owner','root',0,'subagent.failed','cancelled','Subagent cancelled',$1::jsonb,NOW(),NOW(),NOW())`,
      [
        JSON.stringify({
          parentRuntimeRunId: cancelled.identity.parentRuntimeRunId,
          parentToolCallId: cancelled.identity.parentToolCallId,
          personaId: cancelled.identity.personaId,
        }),
      ]
    );
    await settleFailedDelegationChildRuns(database, 'resume-leg', 'parent-cancelled');
    expect(
      (
        await database.query('SELECT status FROM brainstrike_assistant_thread_runs WHERE id = $1', [
          cancelled.runId,
        ])
      ).rows
    ).toEqual([{ status: 'cancelled' }]);
    expect(
      (
        await database.query(
          'SELECT kind,status FROM brainstrike_assistant_run_events WHERE id = $1',
          [`${cancelled.runId}:background-task-terminal`]
        )
      ).rows
    ).toEqual([{ kind: 'run.cancelled', status: 'cancelled' }]);
  });

  it('retries one saturated-host settlement without writing duplicate terminals', async () => {
    const failed = await child('retry-failed', { nativeStatus: 'failed' });
    await reportFailedInvocation(failed.identity, 'retry-parent-failed');
    const query = vi.spyOn(database, 'query').mockRejectedValueOnce(
      new DbHostRequestTimeoutError({
        pendingCount: 2,
        requestKind: 'query',
        timeoutMs: 30_000,
        willTerminateHost: false,
      })
    );
    try {
      await settleFailedDelegationChildRuns(database, 'resume-leg', 'retry-parent-failed');
      expect(query).toHaveBeenCalledTimes(2);
    } finally {
      query.mockRestore();
    }
    expect(
      (
        await database.query('SELECT status FROM brainstrike_assistant_thread_runs WHERE id=$1', [
          failed.runId,
        ])
      ).rows
    ).toEqual([{ status: 'failed' }]);
    expect(
      (
        await database.query('SELECT kind FROM brainstrike_assistant_run_events WHERE id=$1', [
          `${failed.runId}:background-task-terminal`,
        ])
      ).rows
    ).toEqual([{ kind: 'run.failed' }]);
  });

  it('retains a prior child error when the native failure has no message', async () => {
    const failed = await child('missing-message', { nativeStatus: 'failed' });
    await database.query('UPDATE brainstrike_assistant_thread_runs SET error=$1 WHERE id=$2', [
      'Earlier child failure detail',
      failed.runId,
    ]);
    await reportFailedInvocation(failed.identity, 'missing-message-parent-failed');
    await settleFailedDelegationChildRuns(database, 'resume-leg', 'missing-message-parent-failed');
    expect(
      (
        await database.query(
          'SELECT status,error FROM brainstrike_assistant_thread_runs WHERE id=$1',
          [failed.runId]
        )
      ).rows
    ).toEqual([{ error: 'Earlier child failure detail', status: 'failed' }]);
  });

  it('keeps a failed child terminal immutable when a queued nonterminal event arrives later', async () => {
    const failed = await child('late-child-event', { nativeStatus: 'failed' });
    await database.query('UPDATE mastra_background_tasks SET error=$1::jsonb WHERE id=$2', [
      JSON.stringify({ message: 'No executor registered' }),
      'late-child-event',
    ]);
    await reportFailedInvocation(failed.identity, 'late-child-parent-failed');
    await settleFailedDelegationChildRuns(database, 'resume-leg', 'late-child-parent-failed');
    await createBudgetedHost(database, 'initial-leg').persistEvent(
      failed.identity,
      'late-child-event-message',
      {
        id: 'late-child-tool-started',
        kind: 'tool.started',
        label: 'Late child tool',
        status: 'running',
        timestamp: '2026-09-17T00:00:03Z',
      },
      1
    );
    expect(
      (
        await database.query(
          'SELECT status,error FROM brainstrike_assistant_thread_runs WHERE id=$1',
          [failed.runId]
        )
      ).rows
    ).toEqual([{ error: 'No executor registered', status: 'failed' }]);
    expect(
      (
        await database.query(
          'SELECT kind,status FROM brainstrike_assistant_run_events WHERE id=$1',
          [`${failed.runId}:background-task-terminal`]
        )
      ).rows
    ).toEqual([{ kind: 'run.failed', status: 'failed' }]);
  });

  it('settles a failed grandchild reported by its immediate child host run', async () => {
    const parent = await child('nested-parent', { nativeStatus: 'completed' });
    const grandchild = await child('nested-failed', {
      nativeStatus: 'failed',
      parent: {
        resourceId: 'nested-parent-owner',
        runId: parent.identity.childRuntimeRunId,
        threadId: 'nested-parent',
      },
    });
    const sibling = await child('nested-sibling', {
      nativeStatus: 'running',
      parent: {
        resourceId: 'nested-parent-owner',
        runId: parent.identity.childRuntimeRunId,
        threadId: 'nested-parent',
      },
    });
    const event = {
      id: 'nested-parent-reports-failure',
      kind: 'subagent.failed',
      label: 'Subagent failed',
      metadata: {
        parentRuntimeRunId: grandchild.identity.parentRuntimeRunId,
        parentToolCallId: grandchild.identity.parentToolCallId,
        personaId: grandchild.identity.personaId,
      },
      status: 'failed',
      timestamp: '2026-09-17T00:00:02Z',
    } as const;
    async function* source(): AsyncIterable<StreamChunk> {
      yield {
        chunk: { event, type: 'run-event' },
        identity: parent.identity,
        messageId: 'nested-parent-message',
        type: 'delegated-conversation-chunk',
      };
    }
    for await (const chunk of observeDesktopAssistantRunEvents(
      source(),
      'resume-leg',
      [],
      async () => database
    )) {
      if (chunk.type !== 'delegated-conversation-chunk') {
        continue;
      }
      expect(
        (
          await database.query('SELECT status FROM brainstrike_assistant_thread_runs WHERE id=$1', [
            grandchild.runId,
          ])
        ).rows
      ).toEqual([{ status: 'failed' }]);
    }
    expect(
      (
        await database.query('SELECT status FROM brainstrike_assistant_thread_runs WHERE id=$1', [
          sibling.runId,
        ])
      ).rows
    ).toEqual([{ status: 'running' }]);
  });

  it('settles a failed descendant reported by an independent child continuation', async () => {
    await child('continued-parent', { completed: true, nativeStatus: 'completed' });
    const previousFailure = await child('previous-native-failed', {
      nativeStatus: 'failed',
      parent: {
        resourceId: 'continued-parent-owner',
        runId: 'continued-parent-native',
        threadId: 'continued-parent',
      },
    });
    await database.query(
      "UPDATE brainstrike_assistant_thread_runs SET status='completed' WHERE id IN ('initial-leg','other-turn-leg')"
    );
    const continuation = createBudgetedHost(database, 'resume-leg').continuation;
    await continuation.prepareContinuation({
      id: 'continued-parent-input',
      text: 'Continue the delegated work.',
      threadId: 'continued-parent',
    });
    const bound = await continuation.bindContinuation({
      id: 'continued-parent-input',
      nativeRunId: 'continued-wake-native',
    });
    const failed = await child('continued-failed', {
      hostLeg: 'resume-leg',
      nativeStatus: 'failed',
      parent: {
        resourceId: 'continued-parent-owner',
        runId: 'continued-wake-native',
        threadId: 'continued-parent',
      },
    });
    await continuation.persistContinuationEvent({
      event: {
        id: 'continuation-reports-previous-failure',
        kind: 'subagent.failed',
        label: 'Subagent failed',
        metadata: {
          parentRuntimeRunId: previousFailure.identity.parentRuntimeRunId,
          parentToolCallId: previousFailure.identity.parentToolCallId,
          personaId: previousFailure.identity.personaId,
        },
        runId: 'continued-wake-native',
        status: 'failed',
        timestamp: '2026-09-17T00:00:01Z',
      },
      id: 'continued-parent-input',
      messageId: bound.messageId,
      sequence: 0,
    });
    expect(
      (
        await database.query('SELECT status FROM brainstrike_assistant_thread_runs WHERE id=$1', [
          previousFailure.runId,
        ])
      ).rows
    ).toEqual([{ status: 'running' }]);
    await continuation.persistContinuationEvent({
      event: {
        id: 'continuation-reports-failure',
        kind: 'subagent.failed',
        label: 'Subagent failed',
        metadata: {
          parentRuntimeRunId: 'continued-wake-native',
          parentToolCallId: failed.identity.parentToolCallId,
          personaId: failed.identity.personaId,
        },
        runId: 'continued-wake-native',
        status: 'failed',
        timestamp: '2026-09-17T00:00:02Z',
      },
      id: 'continued-parent-input',
      messageId: bound.messageId,
      sequence: 1,
    });
    expect(
      (
        await database.query('SELECT status FROM brainstrike_assistant_thread_runs WHERE id=$1', [
          failed.runId,
        ])
      ).rows
    ).toEqual([{ status: 'failed' }]);
    expect(
      (
        await database.query('SELECT status FROM brainstrike_assistant_thread_runs WHERE id=$1', [
          previousFailure.runId,
        ])
      ).rows
    ).toEqual([{ status: 'running' }]);
  });

  it('rolls back root and child status together when the terminal event cannot be written', async () => {
    const seeded = await child('cancelled');
    await database.exec(`CREATE FUNCTION reject_failure_terminal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'terminal write refused'; END; $$;
      CREATE TRIGGER reject_failure_terminal BEFORE INSERT ON brainstrike_assistant_run_events FOR EACH ROW EXECUTE FUNCTION reject_failure_terminal();`);
    await expect(
      completeFailedRootRun(database, 'initial-leg', 'usage-binding-conflict')
    ).rejects.toThrow('terminal write refused');
    expect(
      (
        await database.query(
          'SELECT status FROM brainstrike_assistant_thread_runs WHERE id IN ($1,$2)',
          ['initial-leg', seeded.runId]
        )
      ).rows
    ).toEqual([{ status: 'running' }, { status: 'running' }]);
  });
});
