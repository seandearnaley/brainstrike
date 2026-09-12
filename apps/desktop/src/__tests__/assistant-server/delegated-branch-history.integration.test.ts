// @vitest-environment node
import { createDelegatedConversationRepository, migrate, wasmLoader } from '@brainstrike/db';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDesktopDelegatedConversationHost } from '../../assistant-server/delegated-conversation-host';

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
  const historyQueries: string[] = [];
  const query = database.query.bind(database);
  vi.spyOn(database, 'query').mockImplementation(async (sql, params) => {
    if (sql.includes('FROM mastra_messages')) {
      historyQueries.push(sql);
    }
    return query(sql, params);
  });
  const first = createDesktopDelegatedConversationHost(database, 'wake-host').continuation;
  const claimed = await first.prepareContinuation(input);
  expect(claimed.branchMessageIds).toHaveLength(81);
  const bound = await first.bindContinuation({ id: input.id, nativeRunId: 'paged-native' });
  expect(bound.baseline.messages.map(({ id }) => id)).toEqual(claimed.branchMessageIds);
  await first.finishContinuation({ id: input.id, status: 'awaiting-approval' });

  const restarted = createDesktopDelegatedConversationHost(database, 'wake-host').continuation;
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
    createDesktopDelegatedConversationHost(database, 'wake-host').continuation.prepareContinuation({
      ...input,
      id: 'missing-paged-ancestor',
    })
  ).rejects.toMatchObject({ reason: 'continuation-branch-history-incomplete' });
});
