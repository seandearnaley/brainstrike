import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { runMigrations } from '../src/drizzle/migrate.js';
import { migration135DelegatedContinuations } from '../src/migrations/135-delegated-continuations.js';
import { migration136DelegatedInputPayload } from '../src/migrations/136-delegated-input-payload.js';
import { createEnginePglite } from '../src/pglite-factory.js';
import { createDelegatedContinuationRepository } from '../src/repositories/delegated-continuation-repository.js';
import { createDelegatedConversationRepository } from '../src/repositories/delegated-conversation-repository.js';
import { getResetTables } from '../src/reset-table-registry.js';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

let database: PGlite;
const scope = { ownerResourceId: 'owner', rootThreadId: 'root' };
const input = { id: 'human-input', text: 'Do the next task once.', threadId: 'child' };
const configuration = {
  maxSteps: 8,
  persona: { id: 'worker', instructions: 'Original instructions' },
};
const repo = (host = 'wake-host') => createDelegatedContinuationRepository(database, scope, host);
const decision = {
  id: input.id,
  kind: 'tool-approval',
  nativeRunId: 'wake-native',
  toolCallId: 'actual-leaf-call',
} as const;
beforeEach(async () => {
  database = await createMigratedTestDb();
  await database.exec(`INSERT INTO mastra_threads(id,"resourceId",title,metadata,"createdAt","updatedAt") VALUES
    ('root','owner','Root','{}',NOW(),NOW()),('child','child-resource','Child','{}',NOW(),NOW()),
    ('leaf','leaf-resource','Leaf','{}',NOW(),NOW()),('other','foreign','Other','{}',NOW(),NOW());
    INSERT INTO brainstrike_assistant_thread_runs(id,resource_id,thread_id,provider,model,runtime_kind,status,started_at,created_at,updated_at,turn_message_id) VALUES
    ('original-host','owner','root','openai','test','desktop','completed',NOW(),NOW(),NOW(),'original-user'),
    ('wake-host','owner','root','openai','test','desktop','running',NOW(),NOW(),NOW(),'new-user'),
    ('other-host','foreign','other','openai','test','desktop','running',NOW(),NOW(),NOW(),'other-user');`);
  const graph = createDelegatedConversationRepository(database);
  await graph.registerRoot(scope);
  await graph.createChild(scope, {
    color: 'blue',
    configuration,
    displayName: 'Cedar',
    parentThreadId: 'root',
    resourceId: 'child-resource',
    threadId: 'child',
  });
  await graph.createChild(scope, {
    color: 'rose',
    configuration,
    displayName: 'Fern',
    parentThreadId: 'child',
    resourceId: 'leaf-resource',
    threadId: 'leaf',
  });
  await graph.createInvocation(scope, {
    hostRunId: 'original-host',
    parentRuntimeRunId: 'parent-native',
    parentThreadId: 'root',
    parentToolCallId: 'parent-tool',
    personaId: 'worker',
    threadId: 'child',
  });
  await graph.bindInvocationRun(
    scope,
    { parentRuntimeRunId: 'parent-native', parentToolCallId: 'parent-tool', personaId: 'worker' },
    'original-native',
    'original-host'
  );
});
afterEach(async () => {
  await database.close();
});

it('migrates a durable continuation receipt independently of original delegation invocation keys', async () => {
  const result = await database.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'brainstrike_delegated_continuations' ORDER BY ordinal_position`
  );
  expect(result.rows).toContainEqual({ column_name: 'native_run_id' });
  expect(result.rows).not.toContainEqual({ column_name: 'parent_tool_call_id' });
});
it('admits one request and binds a fresh native run without rewriting the original invocation', async () => {
  const original = await database.query('SELECT * FROM brainstrike_delegated_invocations');
  expect(await repo().prepare(input)).toMatchObject({
    configuration,
    id: input.id,
    resourceId: 'child-resource',
    state: 'claimed',
    threadId: 'child',
  });
  await expect(repo().bind(input.id, 'original-native')).rejects.toThrow();
  expect(await repo().bind(input.id, 'wake-native')).toMatchObject({
    nativeRunId: 'wake-native',
    state: 'running',
  });
  await expect(repo().bind(input.id, 'different-native')).rejects.toThrow();
  await repo().finish(input.id, 'completed');
  await expect(repo().prepare(input)).rejects.toThrow();
  expect(await database.query('SELECT * FROM brainstrike_delegated_invocations')).toEqual(original);
});
it('distinguishes admitted retries from new refusals without replaying or replacing their input', async () => {
  await repo().prepare(input);
  await expect(repo().prepare(input)).rejects.toMatchObject({
    reason: 'continuation-input-already-admitted',
  });
  await expect(repo().prepare({ ...input, text: 'changed input' })).rejects.toMatchObject({
    reason: 'continuation-input-id-conflict',
  });
  await repo().bind(input.id, 'wake-native');
  await repo().finish(input.id, 'completed');
  await expect(repo().prepare(input)).rejects.toMatchObject({
    reason: 'continuation-input-already-admitted',
  });
  expect(
    (
      await database.query(
        'SELECT input_text, native_run_id, state FROM brainstrike_delegated_continuations'
      )
    ).rows
  ).toEqual([{ input_text: input.text, native_run_id: 'wake-native', state: 'completed' }]);
});
it('atomically refuses concurrent duplicate requests and conflicting child wakes', async () => {
  const attempts = await Promise.allSettled([
    repo().prepare(input),
    repo().prepare(input),
    repo().prepare({ ...input, id: 'another-input', threadId: 'leaf' }),
  ]);
  expect(attempts.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
  expect(
    (await database.query('SELECT id FROM brainstrike_delegated_continuations')).rows
  ).toHaveLength(1);
});
it('rechecks the complete native ancestry and current host owner at admission and binding', async () => {
  await expect(repo('other-host').prepare(input)).rejects.toThrow();
  await database.query(
    `UPDATE mastra_threads SET "resourceId" = 'changed-resource' WHERE id = 'child'`
  );
  await expect(repo().prepare({ ...input, threadId: 'leaf' })).rejects.toThrow();
  await database.query(
    `UPDATE mastra_threads SET "resourceId" = 'child-resource' WHERE id = 'child'`
  );
  await repo().prepare(input);
  await database.query(
    `UPDATE brainstrike_assistant_thread_runs SET resource_id = 'foreign' WHERE id = 'wake-host'`
  );
  await expect(repo().bind(input.id, 'wake-native')).rejects.toThrow();
});
it.each(['running', 'cancelling', 'awaiting-input', 'awaiting-approval'])(
  'refuses a child with a %s execution owner',
  async (state) => {
    await database.query(
      `INSERT INTO brainstrike_assistant_thread_runs(id,resource_id,thread_id,provider,model,runtime_kind,status,started_at,created_at,updated_at)
    VALUES ('child-active','child-resource','child','openai','test','desktop',$1,NOW(),NOW(),NOW())`,
      [state]
    );
    await expect(repo().prepare(input)).rejects.toThrow();
  }
);
it('persists pending decisions and consumes each exact leaf at most once across fresh host legs', async () => {
  await repo().prepare(input);
  await repo().bind(input.id, 'wake-native');
  await repo().finish(input.id, 'awaiting-approval');
  await expect(repo().prepare({ ...input, id: 'while-waiting' })).rejects.toThrow();
  await database.exec(`UPDATE brainstrike_assistant_thread_runs SET status='completed' WHERE id='wake-host';
    INSERT INTO brainstrike_assistant_thread_runs(id,resource_id,thread_id,provider,model,runtime_kind,status,started_at,created_at,updated_at,turn_message_id)
    VALUES ('resume-host','owner','root','openai','test','desktop','running',NOW(),NOW(),NOW(),'new-user');`);
  await expect(
    repo('resume-host').resolveDecision({ ...decision, nativeRunId: 'forged' })
  ).rejects.toThrow();
  await expect(
    repo('resume-host').resolveDecision({ ...decision, kind: 'tool-resume' })
  ).rejects.toThrow();
  expect(await repo('resume-host').resolveDecision(decision)).toMatchObject({
    configuration,
    nativeRunId: 'wake-native',
  });
  await database.query(
    "UPDATE brainstrike_assistant_thread_runs SET turn_message_id='wrong-turn' WHERE id='resume-host'"
  );
  await expect(repo('resume-host').claimDecision(decision)).rejects.toThrow();
  await database.query(
    "UPDATE brainstrike_assistant_thread_runs SET turn_message_id='new-user' WHERE id='resume-host'"
  );
  const results = await Promise.allSettled([
    repo('resume-host').claimDecision(decision),
    repo('resume-host').claimDecision(decision),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  await repo('resume-host').finishDecision(decision);
  await repo('resume-host').finish(input.id, 'completed');
  await expect(repo('resume-host').resolveDecision(decision)).rejects.toThrow();
  await expect(repo('resume-host').releaseDecision(decision)).rejects.toThrow();
});
it('rolls back only an unexecuted exact decision claim to the original pending owner', async () => {
  await repo().prepare(input);
  await repo().bind(input.id, 'wake-native');
  await repo().finish(input.id, 'awaiting-approval');
  await repo().claimDecision(decision);
  await expect(repo().releaseDecision({ ...decision, toolCallId: 'wrong' })).rejects.toThrow();
  await repo().releaseDecision(decision);
  expect(await repo().resolveDecision(decision)).toMatchObject({ state: 'awaiting-approval' });
  expect(
    (await database.query('SELECT * FROM brainstrike_delegated_continuation_decisions')).rows
  ).toHaveLength(0);
});
it('writes real child run events and root-attributed usage without double-counting or fabricated delegation keys', async () => {
  await repo().prepare(input);
  await repo().bind(input.id, 'wake-native');
  const event = {
    id: 'start',
    kind: 'run.started',
    label: 'Working',
    metadata: { continuationId: input.id },
    runId: 'display-child-run',
    sequence: 0,
    status: 'running',
    timestamp: '2026-09-12T01:00:00.000Z',
  } as const;
  await repo().recordEvent(input.id, event);
  await repo().recordEvent(input.id, event);
  await expect(
    repo().recordEvent(input.id, { ...event, label: 'Conflicting delivery' })
  ).rejects.toThrow();
  await repo().recordUsage(input.id, { inputTokens: 5, outputTokens: 3 });
  await repo().recordUsage(input.id, { inputTokens: 4, outputTokens: 3 });
  expect(
    (await database.query('SELECT thread_id,resource_id FROM brainstrike_assistant_run_events'))
      .rows
  ).toEqual([{ resource_id: 'child-resource', thread_id: 'child' }]);
  expect(
    (
      await database.query(
        'SELECT thread_id,run_id,input_tokens,output_tokens,delegation_parent_run_id,delegation_tool_call_id,continuation_id FROM brainstrike_assistant_run_usage'
      )
    ).rows
  ).toEqual([
    {
      continuation_id: input.id,
      delegation_parent_run_id: null,
      delegation_tool_call_id: null,
      input_tokens: 5,
      output_tokens: 3,
      run_id: 'wake-host',
      thread_id: 'root',
    },
  ]);
});
it('deletes continuation/decision receipts with native child deletion while preserving spent root usage', async () => {
  await repo().prepare(input);
  await repo().bind(input.id, 'wake-native');
  await repo().recordUsage(input.id, { inputTokens: 5, outputTokens: 3 });
  await repo().finish(input.id, 'awaiting-approval');
  await repo().claimDecision(decision);
  await database.query(`DELETE FROM mastra_threads WHERE id='child'`);
  expect(
    (await database.query('SELECT * FROM brainstrike_delegated_continuations')).rows
  ).toHaveLength(0);
  expect(
    (await database.query('SELECT * FROM brainstrike_delegated_continuation_decisions')).rows
  ).toHaveLength(0);
  expect(
    (
      await database.query(
        'SELECT input_tokens,continuation_id FROM brainstrike_assistant_run_usage'
      )
    ).rows
  ).toEqual([{ continuation_id: null, input_tokens: 5 }]);
});
it('registers all new receipts for reset and upgrades/replays the actual production migration ledger', async () => {
  expect(getResetTables()).toEqual(
    expect.arrayContaining([
      'brainstrike_delegated_continuations',
      'brainstrike_delegated_continuation_decisions',
    ])
  );
  if (typeof migration135DelegatedContinuations.down !== 'string') {
    throw new Error('Expected SQL migration');
  }
  await database.exec(migration135DelegatedContinuations.down);
  await database.query('DELETE FROM __drizzle_migrations WHERE hash IN ($1, $2)', [
    migration135DelegatedContinuations.ledgerKey,
    migration136DelegatedInputPayload.ledgerKey,
  ]);
  await runMigrations(database);
  await runMigrations(database);
  expect(await repo().prepare(input)).toMatchObject({ state: 'claimed' });
});

it('retains ambiguous claimed input after reconstructing the actual engine without replaying it', async () => {
  await repo().prepare(input);
  const snapshot = await database.dumpDataDir('none');
  await database.close();
  database = await createEnginePglite({ loadDataDir: snapshot });
  expect(await repo().read(input.id)).toMatchObject({ configuration, state: 'claimed' });
  await expect(repo().prepare(input)).rejects.toThrow();
});
it('preserves actual grandchild depth and refuses binding after the cancellation fence', async () => {
  expect(await repo().prepare({ ...input, threadId: 'leaf' })).toMatchObject({ depth: 2 });
  await database.query(
    'UPDATE brainstrike_delegated_continuations SET cancellation_requested_at = NOW() WHERE id=$1',
    [input.id]
  );
  await expect(repo().bind(input.id, 'wake-native')).rejects.toThrow();
});

it('discovers persisted continuation ownership read-only without inventing a live host run', async () => {
  await repo().prepare(input);
  await repo().bind(input.id, 'wake-native');
  await database.query(
    "UPDATE brainstrike_assistant_thread_runs SET status='completed' WHERE id='wake-host'"
  );
  const graph = createDelegatedConversationRepository(database);
  expect(await graph.getContinuation(scope, input.id)).toMatchObject({
    depth: 1,
    nativeRunId: 'wake-native',
    threadId: 'child',
  });
  await database.query("UPDATE mastra_threads SET \"resourceId\"='changed' WHERE id='child'");
  expect(await graph.getContinuation(scope, input.id)).toBeNull();
});

it('accounts separately for each native resume leg while deduplicating cumulative delivery within that leg', async () => {
  await repo().prepare(input);
  await repo().bind(input.id, 'wake-native');
  await repo().recordUsage(input.id, { inputTokens: 5, outputTokens: 3 });
  await repo().finish(input.id, 'awaiting-approval');
  await database.exec(
    "UPDATE brainstrike_assistant_thread_runs SET status='completed' WHERE id='wake-host'; INSERT INTO brainstrike_assistant_thread_runs(id,resource_id,thread_id,provider,model,runtime_kind,status,started_at,created_at,updated_at,turn_message_id) VALUES ('resume-host','owner','root','openai','test','desktop','running',NOW(),NOW(),NOW(),'new-user')"
  );
  await repo('resume-host').claimDecision(decision);
  await repo('resume-host').recordUsage(input.id, { inputTokens: 2, outputTokens: 4 });
  await repo('resume-host').recordUsage(input.id, { inputTokens: 2, outputTokens: 4 });
  expect(
    (
      await database.query(
        'SELECT SUM(input_tokens)::int AS input, SUM(output_tokens)::int AS output FROM brainstrike_assistant_run_usage'
      )
    ).rows
  ).toEqual([{ input: 7, output: 7 }]);
});

it('attributes delimiter-containing receipt and host pairs without primary-key collisions', async () => {
  await database.exec(
    "UPDATE brainstrike_assistant_thread_runs SET status='completed' WHERE id='wake-host'; INSERT INTO brainstrike_assistant_thread_runs(id,resource_id,thread_id,provider,model,runtime_kind,status,started_at,created_at,updated_at,turn_message_id) VALUES ('c','owner','root','openai','test','desktop','running',NOW(),NOW(),NOW(),'turn-one')"
  );
  await repo('c').prepare({ ...input, id: 'a:b' });
  await repo('c').bind('a:b', 'native-one');
  await repo('c').recordUsage('a:b', { inputTokens: 1, outputTokens: 2 });
  await repo('c').finish('a:b', 'completed');
  await database.exec(
    "UPDATE brainstrike_assistant_thread_runs SET status='completed' WHERE id='c'; INSERT INTO brainstrike_assistant_thread_runs(id,resource_id,thread_id,provider,model,runtime_kind,status,started_at,created_at,updated_at,turn_message_id) VALUES ('b:c','owner','root','openai','test','desktop','running',NOW(),NOW(),NOW(),'turn-two')"
  );
  await repo('b:c').prepare({ ...input, id: 'a' });
  await repo('b:c').bind('a', 'native-two');
  await repo('b:c').recordUsage('a', { inputTokens: 3, outputTokens: 4 });
  expect(
    (
      await database.query(
        'SELECT continuation_id, run_id, input_tokens FROM brainstrike_assistant_run_usage ORDER BY continuation_id'
      )
    ).rows
  ).toEqual([
    { continuation_id: 'a', input_tokens: 3, run_id: 'b:c' },
    { continuation_id: 'a:b', input_tokens: 1, run_id: 'c' },
  ]);
});

it('refuses a reused global input identity from another root without disclosing or replacing its receipt', async () => {
  await repo().prepare(input);
  const original = (await database.query('SELECT * FROM brainstrike_delegated_continuations')).rows;
  await database.exec(
    `INSERT INTO mastra_threads(id,"resourceId",title,metadata,"createdAt","updatedAt") VALUES ('other-child','other-child-resource','Other child','{}',NOW(),NOW())`
  );
  const otherScope = { ownerResourceId: 'foreign', rootThreadId: 'other' };
  const graph = createDelegatedConversationRepository(database);
  await graph.registerRoot(otherScope);
  await graph.createChild(otherScope, {
    color: 'blue',
    configuration,
    displayName: 'Other child',
    parentThreadId: 'other',
    resourceId: 'other-child-resource',
    threadId: 'other-child',
  });
  const other = createDelegatedContinuationRepository(database, otherScope, 'other-host');
  await expect(other.prepare({ ...input, threadId: 'other-child' })).rejects.toMatchObject({
    reason: 'continuation-input-not-admitted',
  });
  expect(await graph.getContinuation(otherScope, input.id)).toBeNull();
  expect((await database.query('SELECT * FROM brainstrike_delegated_continuations')).rows).toEqual(
    original
  );
});

const imageAttachment = {
  data: 'data:image/png;base64,AQID',
  filename: 'evidence.png',
  mediaType: 'image/png',
  type: 'file',
} as const;
it('retains the complete image-only receipt across an actual engine restart and rejects changed-content reuse', async () => {
  const imageInput = { ...input, attachments: [imageAttachment], text: '' };
  await repo().prepare(imageInput);
  const snapshot = await database.dumpDataDir('none');
  await database.close();
  database = await createEnginePglite({ loadDataDir: snapshot });
  expect(
    (
      await database.query(
        'SELECT input_text, input_payload FROM brainstrike_delegated_continuations'
      )
    ).rows
  ).toEqual([{ input_payload: { attachments: [imageAttachment], text: '' }, input_text: '' }]);
  await expect(repo().prepare(imageInput)).rejects.toMatchObject({
    reason: 'continuation-input-already-admitted',
  });
  await expect(
    repo().prepare({
      ...imageInput,
      attachments: [{ ...imageAttachment, data: 'data:image/png;base64,BAUG' }],
    })
  ).rejects.toMatchObject({ reason: 'continuation-input-id-conflict' });
  await database.query("DELETE FROM mastra_threads WHERE id='child'");
  expect(
    (await database.query('SELECT input_payload FROM brainstrike_delegated_continuations')).rows
  ).toHaveLength(0);
});
it.each([false, true])(
  'rolls back text-only receipts and replays migration 136 without losing identity (legacy=%s)',
  async (legacy) => {
    await repo().prepare(input);
    // Recreate the exact previous-version shape with a real admitted text receipt.
    if (legacy) {
      await database.query('UPDATE brainstrike_delegated_continuations SET input_payload=NULL');
    }
    if (typeof migration136DelegatedInputPayload.down !== 'string') {
      throw new Error('Expected SQL migration');
    }
    await database.exec(migration136DelegatedInputPayload.down);
    expect(
      (await database.query('SELECT id, input_text FROM brainstrike_delegated_continuations')).rows
    ).toEqual([{ id: input.id, input_text: input.text }]);
    await database.query('DELETE FROM __drizzle_migrations WHERE hash=$1', [
      migration136DelegatedInputPayload.ledgerKey,
    ]);
    expect(await runMigrations(database)).toMatchObject({ success: true });
    expect(await runMigrations(database)).toMatchObject({ success: true });
    expect(
      (
        await database.query(
          'SELECT input_text, input_payload FROM brainstrike_delegated_continuations'
        )
      ).rows
    ).toEqual([{ input_payload: null, input_text: input.text }]);
    await expect(repo().prepare(input)).rejects.toMatchObject({
      reason: 'continuation-input-already-admitted',
    });
    await expect(
      repo().prepare({ ...input, attachments: [imageAttachment] })
    ).rejects.toMatchObject({
      reason: 'continuation-input-id-conflict',
    });
    await expect(repo().prepare({ ...input, text: 'Different text' })).rejects.toMatchObject({
      reason: 'continuation-input-id-conflict',
    });
  }
);
it('refuses a destructive migration downgrade once native image input has been admitted', async () => {
  await repo().prepare({ ...input, attachments: [imageAttachment] });
  if (typeof migration136DelegatedInputPayload.down !== 'string') {
    throw new Error('Expected SQL migration');
  }
  await expect(database.exec(migration136DelegatedInputPayload.down)).rejects.toThrow(
    'Cannot discard admitted child input payloads'
  );
  expect(
    (await database.query('SELECT input_payload FROM brainstrike_delegated_continuations')).rows
  ).toHaveLength(1);
});

it('rejects an empty or malformed durable image payload at the SQL boundary', async () => {
  await repo().prepare({ ...input, attachments: [imageAttachment], text: '' });
  await expect(
    database.query('UPDATE brainstrike_delegated_continuations SET input_payload=$1::jsonb', [
      JSON.stringify({ attachments: [], text: '' }),
    ])
  ).rejects.toThrow();
  await expect(
    database.query('UPDATE brainstrike_delegated_continuations SET input_payload=$1::jsonb', [
      JSON.stringify({ text: '' }),
    ])
  ).rejects.toThrow();
});

it('refuses text-payload rollback when it would change the admitted content identity', async () => {
  await repo().prepare(input);
  const payload = { attachments: [], text: 'Different durable payload text' };
  await database.query('UPDATE brainstrike_delegated_continuations SET input_payload=$1::jsonb', [
    JSON.stringify(payload),
  ]);
  if (typeof migration136DelegatedInputPayload.down !== 'string') {
    throw new Error('Expected SQL migration');
  }
  await expect(database.exec(migration136DelegatedInputPayload.down)).rejects.toThrow(
    'Cannot discard admitted child input payloads'
  );
  expect(
    (
      await database.query(
        'SELECT input_text, input_payload FROM brainstrike_delegated_continuations'
      )
    ).rows
  ).toEqual([{ input_payload: payload, input_text: input.text }]);
});
