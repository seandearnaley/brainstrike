import type { DelegatedRunIdentity } from '@brainstrike/agent';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { completeFailedRootRun } from '../../assistant-server/delegated-stream-failure';
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
