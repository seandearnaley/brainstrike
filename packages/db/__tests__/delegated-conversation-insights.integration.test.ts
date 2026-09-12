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
