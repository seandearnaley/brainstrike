import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createDelegatedContinuationRepository } from '../src/repositories/delegated-continuation-repository.js';
import { readDelegatedConversationInsights } from '../src/repositories/delegated-conversation-insights.js';
import { createDelegatedConversationRepository } from '../src/repositories/delegated-conversation-repository.js';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

let database: PGlite;
const scope = { ownerResourceId: 'owner', rootThreadId: 'root' };
const configuration = { maxSteps: 8, persona: { id: 'worker', instructions: 'Original profile' } };
const graph = () => createDelegatedConversationRepository(database);
const invocation = (threadId: string) => ({
  parentRuntimeRunId: 'parent-native',
  parentToolCallId: threadId,
  personaId: 'worker',
});
beforeEach(async () => {
  database = await createMigratedTestDb();
  await database.exec(`INSERT INTO mastra_threads(id,"resourceId",title,metadata,"createdAt","updatedAt") VALUES
    ('root','owner','Root','{}',NOW(),NOW()),('child','child-owner','Child','{}',NOW(),NOW()),
    ('sibling','sibling-owner','Sibling','{}',NOW(),NOW()),('leaf','leaf-owner','Leaf','{}',NOW(),NOW());
    INSERT INTO brainstrike_assistant_thread_runs(id,resource_id,thread_id,provider,model,runtime_kind,status,started_at,created_at,updated_at,turn_message_id) VALUES
    ('original-host','owner','root','openai','test','desktop','running',NOW(),NOW(),NOW(),'original-user'),
    ('wake-host','owner','root','openai','test','desktop','running',NOW(),NOW(),NOW(),'new-user');`);
  await graph().registerRoot(scope);
  for (const threadId of ['child', 'sibling', 'leaf']) {
    await graph().createChild(scope, {
      color: 'blue',
      configuration,
      displayName: threadId,
      parentThreadId: threadId === 'leaf' ? 'child' : 'root',
      resourceId: `${threadId}-owner`,
      threadId,
    });
    await graph().createInvocation(scope, {
      ...invocation(threadId),
      hostRunId: 'original-host',
      parentThreadId: threadId === 'leaf' ? 'child' : 'root',
      threadId,
    });
    await graph().bindInvocationRun(
      scope,
      invocation(threadId),
      `${threadId}-native`,
      'original-host'
    );
    await graph().recordInvocationEvent(
      scope,
      { ...invocation(threadId), childRuntimeRunId: `${threadId}-native` },
      'original-host',
      {
        id: `event-${threadId}`,
        kind: 'run.started',
        label: 'Child started',
        metadata: { ...invocation(threadId), childRuntimeRunId: `${threadId}-native` },
        runId: `run-${threadId}`,
        sequence: 0,
        status: 'running',
        timestamp: '2026-09-12T12:00:00.000Z',
      }
    );
  }
});
afterEach(async () => {
  await database.close();
});

async function usage(threadId: string, inputTokens: number, outputTokens: number): Promise<void> {
  await graph().recordInvocationUsage(scope, invocation(threadId), {
    currentHostRunId: 'original-host',
    id: `usage-${threadId}`,
    inputTokens,
    model: threadId === 'leaf' ? 'unpriced-custom-model' : 'test',
    outputTokens,
    provider: 'openai',
    resourceId: `${threadId}-owner`,
    threadId,
  });
}

it('reads direct and subtree captured usage from actual invocation and continuation ownership, never root totals', async () => {
  await usage('child', 10, 2);
  await usage('sibling', 100, 20);
  await usage('leaf', 30, 4);
  // Repeated finish reports are monotonic updates, not another billable invocation.
  await usage('child', 10, 2);
  await database.query(
    `UPDATE brainstrike_assistant_thread_runs SET status='completed', completed_at=NOW() WHERE id <> 'wake-host'`
  );
  const continuation = createDelegatedContinuationRepository(database, scope, 'wake-host');
  await continuation.prepare({ id: 'next-child', text: 'Continue once', threadId: 'child' });
  await continuation.bind('next-child', 'next-native');
  await continuation.recordUsage('next-child', {
    inputTokens: 5,
    model: 'test',
    outputTokens: 1,
    provider: 'openai',
  });
  const result = await readDelegatedConversationInsights(database, scope, 'child');
  expect(result).toMatchObject({
    configuration,
    depth: 1,
    directUsage: { totalInputTokens: 15, totalOutputTokens: 3 },
    latestRun: { model: 'test', provider: 'openai' },
    subtreeUsage: { totalInputTokens: 45, totalOutputTokens: 7 },
  });
  expect(await readDelegatedConversationInsights(database, scope, 'sibling')).toMatchObject({
    directUsage: { totalInputTokens: 100, totalOutputTokens: 20 },
    subtreeUsage: { totalInputTokens: 100, totalOutputTokens: 20 },
  });
  expect(await readDelegatedConversationInsights(database, scope, 'leaf')).toMatchObject({
    depth: 2,
    directUsage: { perModel: [expect.objectContaining({ model: 'unpriced-custom-model' })] },
  });
});

it('keeps absent usage unknown even when a child run exists', async () => {
  expect(await readDelegatedConversationInsights(database, scope, 'child')).toMatchObject({
    directUsage: null,
    latestRun: { model: 'test' },
    subtreeUsage: null,
  });
});

it('rejects foreign ownership, roots and a tampered native ancestor without exposing child data', async () => {
  await expect(
    readDelegatedConversationInsights(database, { ...scope, ownerResourceId: 'foreign' }, 'child')
  ).rejects.toThrow();
  await expect(readDelegatedConversationInsights(database, scope, 'root')).rejects.toThrow();
  await database.query(`UPDATE mastra_threads SET "resourceId"='changed-owner' WHERE id='child'`);
  await expect(readDelegatedConversationInsights(database, scope, 'leaf')).rejects.toThrow();
});

it('preserves provider-reported cost and cache token classes without estimating the same billed tokens twice', async () => {
  await usage('child', 10, 2);
  await database.query(
    `UPDATE brainstrike_assistant_run_usage SET billed_cost_usd=0.125, cache_read_input_tokens=3, cache_creation_input_tokens=2 WHERE id='usage-child'`
  );
  expect(await readDelegatedConversationInsights(database, scope, 'child')).toMatchObject({
    directUsage: {
      perModel: [
        {
          billedCostUsd: 0.125,
          cacheCreationTokens: 2,
          cacheReadTokens: 3,
          estimatedInputTokens: 0,
          estimatedOutputTokens: 0,
          inputTokens: 10,
          outputTokens: 2,
        },
      ],
    },
  });
});

it('preserves unbilled cache classes for the ordinary per-model cost estimator', async () => {
  await usage('child', 10, 2);
  await database.query(
    `UPDATE brainstrike_assistant_run_usage SET cache_read_input_tokens=3, cache_creation_input_tokens=2 WHERE id='usage-child'`
  );
  expect(await readDelegatedConversationInsights(database, scope, 'child')).toMatchObject({
    directUsage: {
      perModel: [
        {
          cacheCreationTokens: 2,
          cacheReadTokens: 3,
          estimatedCacheCreationTokens: 2,
          estimatedCacheReadTokens: 3,
        },
      ],
    },
  });
});

it('refuses a stored usage row with two execution owners instead of counting or silently dropping it', async () => {
  await usage('child', 10, 2);
  await database.query(
    `UPDATE brainstrike_assistant_thread_runs SET status='completed', completed_at=NOW() WHERE id <> 'wake-host'`
  );
  const continuation = createDelegatedContinuationRepository(database, scope, 'wake-host');
  await continuation.prepare({ id: 'conflicting-receipt', text: 'Continue', threadId: 'child' });
  await continuation.bind('conflicting-receipt', 'conflicting-native');
  await database.query(
    `UPDATE brainstrike_assistant_run_usage SET continuation_id='conflicting-receipt' WHERE id='usage-child'`
  );
  await expect(readDelegatedConversationInsights(database, scope, 'child')).rejects.toThrow(
    'conflicting execution owners'
  );
});

it('reads only this child latest admitted execution snapshot while preserving the original catalog ceiling', async () => {
  await database.exec(
    "UPDATE brainstrike_assistant_thread_runs SET status='completed' WHERE id <> 'wake-host'"
  );
  const admitted = {
    ...configuration,
    execution: { model: 'chosen-child', planMode: true, provider: 'openai' },
  };
  await createDelegatedContinuationRepository(database, scope, 'wake-host').prepare(
    { id: 'configured-input', text: 'Continue', threadId: 'child' },
    admitted
  );
  const result = await readDelegatedConversationInsights(database, scope, 'child');
  expect(result.configuration).toEqual(configuration);
  expect(result.latestExecutionConfiguration).toEqual(admitted);
  expect(
    (await readDelegatedConversationInsights(database, scope, 'sibling'))
      .latestExecutionConfiguration
  ).toBeNull();
});

it('reads the child budget of the most recent host turn, and null when no budget row exists', async () => {
  expect((await readDelegatedConversationInsights(database, scope, 'child')).budget).toBeNull();
  await database.exec(`INSERT INTO brainstrike_delegation_budgets
    (root_thread_id, turn_message_id, owner_resource_id, max_depth, max_invocations, max_output_tokens,
     max_child_steps, max_child_output_tokens, max_step_output_tokens, synthesis_output_tokens) VALUES
    ('root', 'original-user', 'owner', 3, 8, 131072, 32, 32768, 8192, 2048),
    ('root', 'new-user', 'owner', 5, 8, 131072, 16, 16384, 4096, 1024);
    INSERT INTO brainstrike_delegation_child_budgets
    (root_thread_id, turn_message_id, child_thread_id, max_steps, steps, charged_output_tokens, synthesis_used) VALUES
    ('root', 'original-user', 'child', 32, 12, 6100, false),
    ('root', 'new-user', 'child', 16, 2, 900, true);`);
  // 'wake-host' (turn new-user) is the later run row: its turn wins.
  await database.query(
    "UPDATE brainstrike_assistant_thread_runs SET started_at = NOW() + INTERVAL '1 minute' WHERE id = 'wake-host'"
  );
  expect((await readDelegatedConversationInsights(database, scope, 'child')).budget).toEqual({
    chargedOutputTokens: 900,
    maxChildOutputTokens: 16_384,
    maxDepth: 5,
    maxSteps: 16,
    steps: 2,
    synthesisUsed: true,
  });
  // A sibling with no budget row of its own stays null even though the turn has one.
  expect((await readDelegatedConversationInsights(database, scope, 'sibling')).budget).toBeNull();
  await database.query(
    "DELETE FROM brainstrike_delegation_child_budgets WHERE turn_message_id = 'new-user'"
  );
  expect((await readDelegatedConversationInsights(database, scope, 'child')).budget).toEqual({
    chargedOutputTokens: 6100,
    maxChildOutputTokens: 32_768,
    maxDepth: 3,
    maxSteps: 32,
    steps: 12,
    synthesisUsed: false,
  });
});

it.each([
  ['run.finished', 'completed'],
  ['run.failed', 'failed'],
  ['run.cancelled', 'cancelled'],
] as const)(
  'settles earlier host legs of the same native invocation on %s only',
  async (kind, status) => {
    // An unrelated native invocation in the same thread must remain untouched.
    await database.exec(`INSERT INTO brainstrike_assistant_thread_runs
    (id,resource_id,thread_id,provider,model,runtime_kind,status,started_at,created_at,updated_at)
    VALUES ('unrelated-child-run','child-owner','child','openai','test','desktop','running',NOW(),NOW(),NOW());`);
    await graph().recordInvocationEvent(
      scope,
      { ...invocation('child'), childRuntimeRunId: 'child-native' },
      'original-host',
      {
        id: 'resumed-terminal',
        kind,
        label: 'Resumed child ended',
        metadata: { ...invocation('child'), childRuntimeRunId: 'child-native' },
        runId: 'resumed-child-run',
        sequence: 0,
        status,
        timestamp: '2026-09-12T12:01:00.000Z',
      }
    );
    expect(
      (
        await database.query(
          "SELECT id,status FROM brainstrike_assistant_thread_runs WHERE thread_id='child' ORDER BY id"
        )
      ).rows
    ).toEqual([
      { id: 'resumed-child-run', status },
      { id: 'run-child', status },
      { id: 'unrelated-child-run', status: 'running' },
    ]);
    expect(
      (
        await database.query(
          "SELECT status FROM brainstrike_assistant_thread_runs WHERE id='run-sibling'"
        )
      ).rows
    ).toEqual([{ status: 'running' }]);
    expect(
      (
        await database.query(
          "SELECT id FROM brainstrike_assistant_run_events WHERE kind IN ('run.finished','run.failed','run.cancelled')"
        )
      ).rows
    ).toEqual([{ id: 'resumed-terminal' }]);
  }
);
