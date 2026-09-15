// @vitest-environment node

import { restoreDelegatedConversationHistory } from '@brainstrike/assistant-data';
import {
  createDelegatedConversationRepository,
  migrate,
  recordAssistantHistoryParent,
  wasmLoader,
} from '@brainstrike/db';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { prepareDelegatedChildBranch } from '../../assistant-server/delegated-child-branch';
import { createBudgetedHost } from './fixtures/budgeted-host';

let database: PGlite;
const scope = { ownerResourceId: 'owner', rootThreadId: 'root' };
const input = {
  branch: { kind: 'retry' as const, messageId: 'paged-branch-81' },
  id: 'historical-retry',
  text: 'Retry this answer.',
  threadId: 'child',
};

beforeEach(async () => {
  database = await wasmLoader.createPGlite('memory://delegated-branch-history');
  await migrate(database);
  await database.exec(`INSERT INTO mastra_threads (id,"resourceId",title,metadata,"createdAt","updatedAt") VALUES
    ('root','owner','Root','{}',NOW(),NOW()),('child','child-resource','Child','{}',NOW(),NOW());
    INSERT INTO brainstrike_assistant_thread_runs(id,resource_id,thread_id,provider,model,runtime_kind,status,started_at,created_at,updated_at,turn_message_id)
    VALUES ('wake-host','owner','root','openai','test','desktop','running',NOW(),NOW(),NOW(),'root-user');`);
  const graph = createDelegatedConversationRepository(database);
  await graph.registerRoot(scope);
  await graph.createChild(scope, {
    color: 'blue',
    configuration: { maxSteps: 8, persona: { id: 'worker' } },
    displayName: 'child',
    parentThreadId: 'root',
    resourceId: 'child-resource',
    threadId: 'child',
  });
  for (let index = 0; index < 100; index += 1) {
    await database.query(
      `INSERT INTO mastra_messages (id,thread_id,"resourceId",role,type,content,"createdAt") VALUES ($1,'child','child-resource',$2,'text',$3,$4)`,
      [
        `paged-branch-${index}`,
        index % 2 === 0 ? 'user' : 'assistant',
        JSON.stringify({ format: 2, parts: [{ text: `paged-${index}`, type: 'text' }] }),
        new Date(Date.UTC(2026, 8, 1, 2, 0, index)),
      ]
    );
  }
});

afterEach(async () => database.close());

it('pages backward to the required ancestors on admission and decision restart', async () => {
  await database.exec(`INSERT INTO brainstrike_assistant_thread_runs
    (id,resource_id,thread_id,provider,model,runtime_kind,status,started_at,created_at,updated_at,turn_message_id) VALUES
    ('included-run','child-resource','child','openai','test','desktop','completed','2026-09-01T02:01:18Z',NOW(),NOW(),'paged-branch-78'),
    ('retried-run','child-resource','child','openai','test','desktop','completed','2026-09-01T02:01:20Z',NOW(),NOW(),'paged-branch-80'),
    ('excluded-run','child-resource','child','openai','test','desktop','completed','2026-09-01T02:01:39Z',NOW(),NOW(),'paged-branch-80');
    INSERT INTO brainstrike_assistant_run_events
    (id,run_id,resource_id,thread_id,sequence,kind,status,label,metadata,occurred_at,created_at,updated_at) VALUES
    ('included-event','included-run','child-resource','child',1,'tool.completed','completed','Included',NULL,NOW(),NOW(),NOW()),
    ('retried-event','retried-run','child-resource','child',1,'tool.completed','completed','Retried',NULL,NOW(),NOW(),NOW()),
    ('excluded-event','excluded-run','child-resource','child',1,'tool.completed','completed','Excluded','{"nativeMessageId":"paged-branch-81"}',NOW(),NOW(),NOW());`);
  const historyQueries: string[] = [];
  const transactionHistoryQueries: string[] = [];
  const query = database.query.bind(database);
  vi.spyOn(database, 'query').mockImplementation(async (sql, params) => {
    if (sql.includes('FROM mastra_messages')) {
      historyQueries.push(sql);
    }
    return query(sql, params);
  });
  const transaction = database.transaction.bind(database);
  vi.spyOn(database, 'transaction').mockImplementation((callback) =>
    transaction(async (tx) => {
      const queryTransaction = tx.query.bind(tx);
      vi.spyOn(tx, 'query').mockImplementation(async (sql, params) => {
        if (sql.includes('FROM mastra_messages')) {
          transactionHistoryQueries.push(sql);
        }
        return queryTransaction(sql, params);
      });
      return callback(tx);
    })
  );
  const first = createBudgetedHost(database, 'wake-host').continuation;
  const claimed = await first.prepareContinuation(input);
  expect(claimed.branchMessageIds).toHaveLength(81);
  const bound = await first.bindContinuation({ id: input.id, nativeRunId: 'paged-native' });
  expect(bound.baseline.messages.map(({ id }) => id)).toEqual(claimed.branchMessageIds);
  const projected = restoreDelegatedConversationHistory(bound.baseline);
  expect(JSON.stringify(projected)).toContain('Included');
  expect(JSON.stringify(projected)).not.toContain('Excluded');
  expect(JSON.stringify(projected)).not.toContain('Retried');
  expect(bound.baseline.runEvents.map(({ id }) => id)).toEqual(['included-event']);
  await first.finishContinuation({ id: input.id, status: 'awaiting-approval' });

  const restarted = createBudgetedHost(database, 'wake-host').continuation;
  const resumed = await restarted.resolveContinuationDecision({
    id: input.id,
    kind: 'tool-approval',
    nativeRunId: 'paged-native',
    toolCallId: 'approval',
  });
  expect(resumed.baseline.headId).toBe('paged-branch-80');
  expect(resumed.baseline.messages.map(({ id }) => id)).toEqual(claimed.branchMessageIds);
  expect(historyQueries.length).toBeGreaterThan(4);
  expect(historyQueries.every((sql) => sql.includes('LIMIT $3'))).toBe(true);
  expect(transactionHistoryQueries.length).toBeGreaterThan(1);
  expect(transactionHistoryQueries.every((sql) => sql.includes('LIMIT $3'))).toBe(true);
});

it('fails closed when a required ancestor disappears from every bounded page', async () => {
  const query = database.query.bind(database);
  vi.spyOn(database, 'query').mockImplementation(async (sql, params) => {
    const result = await query(sql, params);
    if (sql.includes('FROM mastra_messages') && sql.includes('LIMIT $3')) {
      return {
        ...result,
        rows: result.rows.filter((row) => (row as { id?: unknown }).id !== 'paged-branch-0'),
      };
    }
    return result;
  });
  await expect(
    createBudgetedHost(database, 'wake-host').continuation.prepareContinuation({
      ...input,
      id: 'missing-paged-ancestor',
    })
  ).rejects.toMatchObject({ reason: 'continuation-branch-history-incomplete' });
});

it('rejects missing and cyclic selections directly at branch preparation', async () => {
  const branchScope = {
    branch: input.branch,
    configuration: {},
    depth: 1,
    id: input.id,
    messageId: 'projection',
    parentThreadId: 'root',
    resourceId: 'child-resource',
    threadId: 'child',
    turnMessageId: 'root-user',
  };
  await expect(
    prepareDelegatedChildBranch(
      database,
      { ...branchScope, branch: { kind: 'retry', messageId: 'missing' } },
      false
    )
  ).rejects.toThrow('no longer available');
  await recordAssistantHistoryParent(database, {
    messageId: 'paged-branch-80',
    parentId: 'paged-branch-81',
    resourceId: 'child-resource',
    threadId: 'child',
  });
  await recordAssistantHistoryParent(database, {
    messageId: 'paged-branch-81',
    parentId: 'paged-branch-80',
    resourceId: 'child-resource',
    threadId: 'child',
  });
  await expect(prepareDelegatedChildBranch(database, branchScope, false)).rejects.toThrow(
    'incomplete or cyclic'
  );
});

it('does not read a capture page for an empty first-message edit prefix', async () => {
  await database.exec(`INSERT INTO brainstrike_assistant_thread_runs
    (id,resource_id,thread_id,provider,model,runtime_kind,status,started_at,created_at,updated_at,turn_message_id)
    VALUES ('legacy-run','child-resource','child','openai','test','desktop','completed',NOW(),NOW(),NOW(),NULL);
    INSERT INTO brainstrike_assistant_run_events
    (id,run_id,resource_id,thread_id,sequence,kind,status,label,occurred_at,created_at,updated_at)
    VALUES ('legacy-event','legacy-run','child-resource','child',1,'tool.completed','completed','Legacy',NOW(),NOW(),NOW());`);
  const historyQueries: string[] = [];
  const query = database.query.bind(database);
  vi.spyOn(database, 'query').mockImplementation(async (sql, params) => {
    if (sql.includes('FROM mastra_messages')) {
      historyQueries.push(sql);
    }
    return query(sql, params);
  });
  const claimed = await createBudgetedHost(database, 'wake-host').continuation;
  const prepared = await claimed.prepareContinuation({
    ...input,
    branch: { kind: 'edit', messageId: 'paged-branch-0' },
    id: 'first-message-edit',
  });
  expect(prepared.branchMessageIds).toEqual([]);
  const bound = await claimed.bindContinuation({
    id: 'first-message-edit',
    nativeRunId: 'first-edit-native',
  });
  expect(bound.baseline.runEvents).toEqual([]);
  // Admission still performs its required bounded target lookup through the
  // transaction handle; this outer spy isolates the post-admission capture.
  expect(historyQueries).toEqual([]);
});
