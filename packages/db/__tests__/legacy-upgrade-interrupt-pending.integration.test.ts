import { MASTRA_WORKFLOW_SCHEMA_SQL } from '@brainstrike/assistant-contract/mastra-memory-schema';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { migration145LegacyUpgradeInterruptPending as upgrade } from '../src/migrations/145-legacy-upgrade-interrupt-pending.js';
import { createDelegatedContinuationRepository } from '../src/repositories/delegated-continuation-repository.js';
import { createDelegatedConversationRepository } from '../src/repositories/delegated-conversation-repository.js';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

let database: PGlite;
const scope = { ownerResourceId: 'owner', rootThreadId: 'root' };

async function seedLegacyPendingState(): Promise<void> {
  await database.exec(`
    INSERT INTO mastra_threads(id,"resourceId",title,metadata,"createdAt","updatedAt") VALUES
      ('root','owner','Root','{}',NOW(),NOW()),('child','child-resource','Child','{}',NOW(),NOW());
    INSERT INTO brainstrike_assistant_thread_runs(id,resource_id,thread_id,provider,model,runtime_kind,status,started_at,created_at,updated_at,turn_message_id) VALUES
      ('pausing-leg','owner','root','openai','test','desktop','completed',NOW(),NOW(),NOW(),'u1'),
      ('answer-leg','owner','root','openai','test','desktop','completed',NOW(),NOW(),NOW(),'u2'),
      ('wake-host','owner','root','openai','test','desktop','running',NOW(),NOW(),NOW(),'u3');
    INSERT INTO brainstrike_assistant_run_events(id,run_id,resource_id,thread_id,sequence,kind,status,label,metadata,occurred_at,created_at,updated_at) VALUES
      -- The pre-pause start shares its pause's millisecond: it is not an answer.
      ('e1','pausing-leg','owner','root',1,'tool.started','running','Write','{"toolCallId":"pending-call"}','2026-10-01T00:00:00.000Z',NOW(),NOW()),
      ('e2','pausing-leg','owner','root',2,'tool.approval.requested','running','Awaiting your approval','{"toolCallId":"pending-call","toolName":"brainstrike.writeWorkspaceFile"}','2026-10-01T00:00:00.000Z',NOW(),NOW()),
      ('e3','pausing-leg','owner','root',3,'tool.approval.requested','running','Awaiting your approval','{"toolCallId":"answered-call","toolName":"brainstrike.readWorkspaceFile"}','2026-10-01T00:00:01.000Z',NOW(),NOW()),
      ('e4','answer-leg','owner','root',1,'tool.completed','completed','Read','{"toolCallId":"answered-call"}','2026-10-01T00:05:00.000Z',NOW(),NOW());
    INSERT INTO mastra_background_tasks(id,tool_call_id,tool_name,agent_id,run_id,thread_id,resource_id,status,args,result,retry_count,max_retries,timeout_ms,"createdAt","completedAt") VALUES
      ('parked-task','c1','agent-worker','root-agent','pausing-leg','root','owner','suspended','{}',NULL,0,0,1000,NOW(),NULL),
      ('undelivered-task','c2','agent-worker','root-agent','pausing-leg','root','owner','completed','{}','{"text":"done"}',0,0,1000,NOW(),NOW());
  `);
  await database.exec(MASTRA_WORKFLOW_SCHEMA_SQL);
  await database.exec(`
    INSERT INTO mastra_workflow_snapshot(workflow_name,run_id,"resourceId",snapshot,"createdAt","updatedAt") VALUES
      ('agentic-loop','question-run','owner','{"status":"suspended","runId":"question-run"}',NOW(),NOW()),
      ('agentic-loop','finished-run','owner','{"status":"success","runId":"finished-run"}',NOW(),NOW());
  `);
  const graph = createDelegatedConversationRepository(database);
  await graph.registerRoot(scope);
  await graph.createChild(scope, {
    color: 'blue',
    configuration: { maxSteps: 8, persona: { id: 'worker', instructions: 'Work.' } },
    displayName: 'Cedar',
    parentThreadId: 'root',
    resourceId: 'child-resource',
    threadId: 'child',
  });
  await graph.createInvocation(scope, {
    hostRunId: 'pausing-leg',
    parentRuntimeRunId: 'parent-native',
    parentThreadId: 'root',
    parentToolCallId: 'parent-tool',
    personaId: 'worker',
    threadId: 'child',
  });
  const continuations = createDelegatedContinuationRepository(database, scope, 'wake-host');
  await continuations.prepare({ id: 'human-input', text: 'Continue.', threadId: 'child' });
  await continuations.bind('human-input', 'wake-native');
  await database.exec(`
    UPDATE brainstrike_delegated_continuations SET state = 'awaiting-approval' WHERE id = 'human-input';
    INSERT INTO brainstrike_delegated_continuation_decisions(continuation_id,native_run_id,target_runtime_run_id,tool_call_id,kind,host_run_id,previous_host_run_id,state) VALUES
      ('human-input','wake-native','leaf-run','leaf-call','tool-approval','wake-host','pausing-leg','claimed');
  `);
}

async function rows(sql: string): Promise<unknown[]> {
  return (await database.query(sql)).rows;
}

beforeEach(async () => {
  database = await createMigratedTestDb();
  await seedLegacyPendingState();
});
afterEach(async () => {
  await database.close();
});

it('interrupts every pending legacy decision once, and leaves finished and undelivered history alone', async () => {
  await database.exec(upgrade.up);
  await database.exec(upgrade.up);

  // The unanswered pause gets exactly one interruption; the answered one none.
  expect(
    await rows(`SELECT run_id, metadata FROM brainstrike_assistant_run_events
      WHERE kind = 'tool.resume.unsupported' ORDER BY id`)
  ).toEqual([
    {
      metadata: {
        interruptedByLegacyUpgrade: true,
        runId: 'pausing-leg',
        toolCallId: 'pending-call',
        toolName: 'brainstrike.writeWorkspaceFile',
      },
      run_id: 'pausing-leg',
    },
  ]);
  // Suspended Mastra runs (questions, plans, approvals) can no longer resume.
  expect(
    await rows(
      `SELECT run_id, snapshot->>'status' AS status FROM mastra_workflow_snapshot ORDER BY run_id`
    )
  ).toEqual([
    { run_id: 'finished-run', status: 'success' },
    { run_id: 'question-run', status: 'canceled' },
  ]);
  expect(
    await rows('SELECT id, status, delivered_at FROM mastra_background_tasks ORDER BY id')
  ).toEqual([
    { delivered_at: null, id: 'parked-task', status: 'cancelled' },
    { delivered_at: null, id: 'undelivered-task', status: 'completed' },
  ]);
  expect(await rows('SELECT id, state FROM brainstrike_delegated_continuations')).toEqual([
    { id: 'human-input', state: 'interrupted' },
  ]);
  expect(
    await rows('SELECT tool_call_id, state FROM brainstrike_delegated_continuation_decisions')
  ).toEqual([{ state: 'interrupted', tool_call_id: 'leaf-call' }]);
});

it('upgrades a profile whose Mastra store never created its workflow table', async () => {
  await database.exec('DROP TABLE mastra_workflow_snapshot');

  await database.exec(upgrade.up);

  expect(
    await rows(`SELECT count(*)::int AS interrupted FROM brainstrike_assistant_run_events
      WHERE kind = 'tool.resume.unsupported'`)
  ).toEqual([{ interrupted: 1 }]);
});
