import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/drizzle/migrate.js';
import { migration128DelegatedInvocationUsage } from '../src/migrations/128-delegated-invocation-usage';
import { migration134DelegatedCancellationAdmission } from '../src/migrations/134-delegated-cancellation-admission';
import { createEnginePglite } from '../src/pglite-factory.js';
import { createDelegatedConversationRepository } from '../src/repositories/delegated-conversation-repository.js';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

describe('durable delegated invocation identity (BST-1718)', () => {
  let database: PGlite;
  const scope = { ownerResourceId: 'owner', rootThreadId: 'root' };
  const invocation = {
    hostRunId: 'host-leg',
    parentRuntimeRunId: 'native-parent-run',
    parentThreadId: 'root',
    parentToolCallId: 'delegate-call',
    personaId: 'explore',
    threadId: 'child',
  };

  beforeEach(async () => {
    database = await createMigratedTestDb();
    await database.exec(`INSERT INTO mastra_threads
      (id, "resourceId", title, metadata, "createdAt", "updatedAt") VALUES
      ('root', 'owner', 'Root', '{}', NOW(), NOW()),
      ('other-root', 'owner', 'Other', '{}', NOW(), NOW()),
      ('child', 'native-resource', 'Child', '{}', NOW(), NOW());
      INSERT INTO brainstrike_assistant_thread_runs
      (id, resource_id, thread_id, provider, model, runtime_kind, status,
       started_at, created_at, updated_at, turn_message_id) VALUES
      ('host-leg', 'owner', 'root', 'openai', 'test', 'desktop', 'running',
       NOW(), NOW(), NOW(), 'user-turn'),
      ('other-host-leg', 'owner', 'other-root', 'openai', 'test', 'desktop', 'running',
       NOW(), NOW(), NOW(), 'other-user-turn');`);
    const repository = createDelegatedConversationRepository(database);
    await repository.registerRoot(scope);
    await repository.createChild(scope, {
      color: 'blue',
      configuration: { personaId: 'explore' },
      displayName: 'Cedar',
      parentThreadId: 'root',
      resourceId: 'native-resource',
      threadId: 'child',
    });
  });

  afterEach(async () => {
    await database.close();
  });

  it('upgrades and replays cancellation admission without changing old invocations or losing a Stop', async () => {
    const repository = createDelegatedConversationRepository(database);
    await repository.createInvocation(scope, invocation);
    if (
      typeof migration134DelegatedCancellationAdmission.down !== 'string' ||
      typeof migration134DelegatedCancellationAdmission.up !== 'string'
    ) {
      throw new Error('Expected SQL migration');
    }
    await database.exec(migration134DelegatedCancellationAdmission.down);
    await database.exec(migration134DelegatedCancellationAdmission.up);
    expect(
      (
        await database.query(
          'SELECT cancellation_requested_at FROM brainstrike_delegated_invocations'
        )
      ).rows
    ).toEqual([{ cancellation_requested_at: null }]);
    await database.exec(
      "UPDATE brainstrike_delegated_invocations SET cancellation_requested_at = '2026-09-11T18:00:00Z'"
    );
    await database.exec(migration134DelegatedCancellationAdmission.up);
    const restored = await createEnginePglite({ loadDataDir: await database.dumpDataDir() });
    try {
      expect(
        (
          await restored.query(
            'SELECT cancellation_requested_at IS NOT NULL AS stopped FROM brainstrike_delegated_invocations'
          )
        ).rows
      ).toEqual([{ stopped: true }]);
      expect(
        await createDelegatedConversationRepository(restored).getInvocation(scope, invocation)
      ).toMatchObject(invocation);
      await restored.query('DELETE FROM mastra_threads WHERE id = $1', [scope.rootThreadId]);
      expect(
        (await restored.query('SELECT * FROM brainstrike_delegated_invocations')).rows
      ).toEqual([]);
    } finally {
      await restored.close();
    }
  });

  it('reloads separate host leg, root turn, native parent and native child identities', async () => {
    const repository = createDelegatedConversationRepository(database);
    const prepared = await repository.createInvocation(scope, invocation);
    expect(prepared).toMatchObject({
      ...scope,
      ...invocation,
      childRuntimeRunId: null,
      turnMessageId: 'user-turn',
    });
    const started = await repository.bindInvocationRun(scope, invocation, 'native-child-run');
    expect(started).toMatchObject({ ...prepared, childRuntimeRunId: 'native-child-run' });
    const recreated = createDelegatedConversationRepository(database);
    expect(await recreated.getInvocation(scope, invocation)).toEqual(started);
    expect(await recreated.bindInvocationRun(scope, invocation, 'native-child-run')).toEqual(
      started
    );
  });
  it('retains the observed parent tool input and rejects changing it on an existing invocation', async () => {
    const repository = createDelegatedConversationRepository(database);
    const originalToolCall = {
      args: { prompt: 'Inspect the failing test' },
      toolName: 'agent-explore',
    };
    await repository.createInvocation(scope, { ...invocation, originalToolCall });
    const recreated = createDelegatedConversationRepository(database);
    expect(await recreated.getInvocation(scope, invocation)).toMatchObject({ originalToolCall });
    await expect(
      recreated.createInvocation(scope, {
        ...invocation,
        originalToolCall: { ...originalToolCall, args: { prompt: 'Different work' } },
      })
    ).rejects.toThrow();
    await expect(recreated.createInvocation(scope, invocation)).rejects.toThrow();
    expect(await recreated.getInvocation(scope, invocation)).toMatchObject({ originalToolCall });
  });

  it('keeps concurrent duplicate creation idempotent and rejects another native child run', async () => {
    const first = createDelegatedConversationRepository(database);
    const second = createDelegatedConversationRepository(database);
    const results = await Promise.all([
      first.createInvocation(scope, invocation),
      second.createInvocation(scope, invocation),
    ]);
    expect(results[0]).toEqual(results[1]);
    await first.bindInvocationRun(scope, invocation, 'native-child-run');
    await expect(second.bindInvocationRun(scope, invocation, 'replacement-run')).rejects.toThrow();
    expect(await second.getInvocation(scope, invocation)).toMatchObject({
      childRuntimeRunId: 'native-child-run',
    });
  });

  it.each([
    { hostRunId: 'other-host-leg' },
    { hostRunId: 'native-parent-run' },
    { parentThreadId: 'other-root' },
    { threadId: 'root' },
    { parentToolCallId: ' ' },
  ])('rejects a forged invocation binding %j', async (changes) => {
    const repository = createDelegatedConversationRepository(database);
    await expect(
      repository.createInvocation(scope, { ...invocation, ...changes })
    ).rejects.toThrow();
    expect(await repository.getInvocation(scope, invocation)).toBeNull();
  });

  it('rejects using the parent native run as its child run', async () => {
    const repository = createDelegatedConversationRepository(database);
    await repository.createInvocation(scope, invocation);
    await expect(
      repository.bindInvocationRun(scope, invocation, invocation.parentRuntimeRunId)
    ).rejects.toThrow();
    expect(await repository.getInvocation(scope, invocation)).toMatchObject({
      childRuntimeRunId: null,
    });
  });

  it('does not rebind an existing invocation to another persona', async () => {
    const repository = createDelegatedConversationRepository(database);
    await repository.createInvocation(scope, invocation);
    await expect(
      repository.createInvocation(scope, { ...invocation, personaId: 'analyze' })
    ).rejects.toThrow();
    expect(await repository.getInvocation(scope, invocation)).toMatchObject({
      personaId: 'explore',
    });
  });

  it.each([null, 'native-child-run'])(
    'rejects another observed persona before publication, including resume (%s)',
    async (previousRun) => {
      const repository = createDelegatedConversationRepository(database);
      await repository.createInvocation(scope, invocation);
      if (previousRun) {
        await repository.bindInvocationRun(scope, invocation, previousRun);
      }
      const recreated = createDelegatedConversationRepository(database);
      await expect(
        recreated.bindInvocationRun(
          scope,
          { ...invocation, personaId: 'analyze' },
          'native-child-run'
        )
      ).rejects.toThrow();
      expect(await recreated.getInvocation(scope, invocation)).toMatchObject({
        childRuntimeRunId: previousRun,
        personaId: 'explore',
      });
    }
  );

  it('gives a follow-up its own invocation on the same child conversation', async () => {
    const repository = createDelegatedConversationRepository(database);
    await repository.createInvocation(scope, invocation);
    await repository.bindInvocationRun(scope, invocation, 'first-child-run');
    const followup = { ...invocation, parentToolCallId: 'followup-call' };
    await repository.createInvocation(scope, followup);
    await expect(
      repository.bindInvocationRun(scope, followup, 'first-child-run')
    ).rejects.toThrow();
    expect(await repository.bindInvocationRun(scope, followup, 'followup-child-run')).toMatchObject(
      {
        childRuntimeRunId: 'followup-child-run',
        parentToolCallId: 'followup-call',
        threadId: 'child',
      }
    );
  });

  it('reconciles cumulative invocation usage once across duplicate delivery and resume', async () => {
    const repository = createDelegatedConversationRepository(database);
    await repository.createInvocation(scope, invocation);
    await repository.bindInvocationRun(scope, invocation, 'native-child-run');
    const usage = {
      currentHostRunId: 'host-leg',
      id: 'usage-first',
      inputTokens: 10,
      model: 'test',
      outputTokens: 5,
      provider: 'openai',
      resourceId: 'native-resource',
      threadId: 'child',
    };
    await repository.recordInvocationUsage(scope, invocation, usage);
    await repository.recordInvocationUsage(scope, invocation, { ...usage, id: 'duplicate' });
    await database.exec(`INSERT INTO brainstrike_assistant_thread_runs
      (id, resource_id, thread_id, provider, model, runtime_kind, status,
       started_at, created_at, updated_at, turn_message_id)
      SELECT 'resume-leg', resource_id, thread_id, provider, model, runtime_kind, status,
        started_at, created_at, updated_at, turn_message_id
      FROM brainstrike_assistant_thread_runs WHERE id = 'host-leg'`);
    await repository.recordInvocationUsage(scope, invocation, {
      ...usage,
      currentHostRunId: 'resume-leg',
      id: 'resumed',
      inputTokens: 20,
      outputTokens: 8,
    });
    await repository.recordInvocationUsage(scope, invocation, { ...usage, id: 'stale-delivery' });
    const rows = await database.query(`SELECT id, run_id, thread_id, input_tokens, output_tokens,
      delegation_parent_run_id, delegation_tool_call_id FROM brainstrike_assistant_run_usage`);
    expect(rows.rows).toEqual([
      {
        delegation_parent_run_id: 'native-parent-run',
        delegation_tool_call_id: 'delegate-call',
        id: 'usage-first',
        input_tokens: 20,
        output_tokens: 8,
        run_id: 'host-leg',
        thread_id: 'root',
      },
    ]);
    await expect(
      repository.recordInvocationUsage(scope, invocation, { ...usage, model: 'changed' })
    ).rejects.toThrow();
    await expect(
      repository.recordInvocationUsage(scope, { ...invocation, personaId: 'analyze' }, usage)
    ).rejects.toThrow();
    await expect(
      repository.recordInvocationUsage(scope, invocation, {
        ...usage,
        currentHostRunId: 'other-host-leg',
      })
    ).rejects.toThrow();
    await database.query(
      `UPDATE brainstrike_assistant_thread_runs SET turn_message_id = 'changed' WHERE id = 'resume-leg'`
    );
    await expect(
      repository.recordInvocationUsage(scope, invocation, {
        ...usage,
        currentHostRunId: 'resume-leg',
      })
    ).rejects.toThrow();
    await database.query(`DELETE FROM mastra_threads WHERE id = 'child'`);
    expect(
      (
        await database.query(`SELECT input_tokens, output_tokens, delegation_parent_run_id, delegation_tool_call_id
      FROM brainstrike_assistant_run_usage`)
      ).rows
    ).toEqual([
      {
        delegation_parent_run_id: null,
        delegation_tool_call_id: null,
        input_tokens: 20,
        output_tokens: 8,
      },
    ]);
  });

  it('does not write usage without an authorized, published native invocation', async () => {
    const repository = createDelegatedConversationRepository(database);
    await repository.createInvocation(scope, invocation);
    const usage = {
      currentHostRunId: 'host-leg',
      id: 'usage',
      inputTokens: 10,
      outputTokens: 5,
      resourceId: 'native-resource',
      threadId: 'child',
    };
    await expect(repository.recordInvocationUsage(scope, invocation, usage)).rejects.toThrow();
    await repository.bindInvocationRun(scope, invocation, 'native-child-run');
    await expect(
      repository.recordInvocationUsage(scope, invocation, { ...usage, inputTokens: Number.NaN })
    ).rejects.toThrow();
    await expect(
      repository.recordInvocationUsage(scope, invocation, { ...usage, threadId: 'other-root' })
    ).rejects.toThrow();
    await database.query(`UPDATE mastra_threads SET "resourceId" = 'changed' WHERE id = 'root'`);
    await expect(repository.recordInvocationUsage(scope, invocation, usage)).rejects.toThrow();
    expect((await database.query('SELECT id FROM brainstrike_assistant_run_usage')).rows).toEqual(
      []
    );
  });

  it('fails closed when the native child scope or host leg ownership changes', async () => {
    const repository = createDelegatedConversationRepository(database);
    await repository.createInvocation(scope, invocation);
    await database.query(`UPDATE mastra_threads SET "resourceId" = 'changed' WHERE id = 'child'`);
    expect(await repository.getInvocation(scope, invocation)).toBeNull();
    await expect(repository.bindInvocationRun(scope, invocation, 'child-run')).rejects.toThrow();
    await database.query(
      `UPDATE mastra_threads SET "resourceId" = 'native-resource' WHERE id = 'child'`
    );
    await database.query(
      `UPDATE brainstrike_assistant_thread_runs SET resource_id = 'changed' WHERE id = 'host-leg'`
    );
    expect(await repository.getInvocation(scope, invocation)).toBeNull();
    await expect(repository.bindInvocationRun(scope, invocation, 'child-run')).rejects.toThrow();
  });

  it('survives engine reconstruction and disappears when its native conversation is deleted', async () => {
    const repository = createDelegatedConversationRepository(database);
    await repository.createInvocation(scope, invocation);
    const saved = await repository.bindInvocationRun(scope, invocation, 'native-child-run');
    const dump = await database.dumpDataDir();
    const reloaded = await createEnginePglite({ loadDataDir: dump });
    try {
      const recreated = createDelegatedConversationRepository(reloaded);
      expect(await recreated.getInvocation(scope, invocation)).toEqual(saved);
      await reloaded.query(`DELETE FROM mastra_threads WHERE id = 'child'`);
      expect(await recreated.getInvocation(scope, invocation)).toBeNull();
      expect(
        (await reloaded.query('SELECT * FROM brainstrike_delegated_invocations')).rows
      ).toEqual([]);
    } finally {
      await reloaded.close();
    }
  });

  it('upgrades historical usage without guessing identity and enforces the invocation join in SQL', async () => {
    if (typeof migration128DelegatedInvocationUsage.down !== 'string') {
      throw new Error('Expected SQL migration');
    }
    await database.exec(migration128DelegatedInvocationUsage.down);
    await database.exec(`INSERT INTO brainstrike_assistant_run_usage
      (id, thread_id, run_id, resource_id, model, provider, input_tokens, output_tokens, run_kind)
      VALUES ('legacy', 'root', 'host-leg', 'owner', 'test', 'openai', 5, 3, 'subagent');
      DELETE FROM __drizzle_migrations WHERE hash = 'custom-128-delegated-invocation-usage';`);
    expect(await runMigrations(database)).toMatchObject({
      appliedMigrations: [expect.anything()],
      success: true,
    });
    expect(
      (
        await database.query(`SELECT input_tokens, output_tokens, delegation_parent_run_id,
      delegation_tool_call_id FROM brainstrike_assistant_run_usage WHERE id = 'legacy'`)
      ).rows
    ).toEqual([
      {
        delegation_parent_run_id: null,
        delegation_tool_call_id: null,
        input_tokens: 5,
        output_tokens: 3,
      },
    ]);
    await expect(
      database.exec(
        `UPDATE brainstrike_assistant_run_usage SET delegation_parent_run_id = 'partial' WHERE id = 'legacy'`
      )
    ).rejects.toThrow();
    await expect(
      database.exec(
        `UPDATE brainstrike_assistant_run_usage SET delegation_parent_run_id = 'missing', delegation_tool_call_id = 'missing' WHERE id = 'legacy'`
      )
    ).rejects.toThrow();
    expect(await runMigrations(database)).toEqual({ appliedMigrations: [], success: true });
  });

  it('upgrades through the production migration ledger and replays without changing invocation identity', async () => {
    if (typeof migration128DelegatedInvocationUsage.down !== 'string') {
      throw new Error('Expected SQL migration');
    }
    await database.exec(migration128DelegatedInvocationUsage.down);
    await database.exec(
      'DROP TABLE brainstrike_delegated_tool_decisions; DROP TABLE brainstrike_delegated_invocations'
    );
    await database.query(
      "DELETE FROM __drizzle_migrations WHERE hash IN ('custom-127-delegated-invocations', 'custom-128-delegated-invocation-usage', 'custom-131-delegated-tool-decisions')"
    );
    expect(await runMigrations(database)).toMatchObject({
      appliedMigrations: [expect.anything(), expect.anything(), expect.anything()],
      success: true,
    });
    const repository = createDelegatedConversationRepository(database);
    const saved = await repository.createInvocation(scope, invocation);
    expect(await runMigrations(database)).toEqual({ appliedMigrations: [], success: true });
    expect(await repository.getInvocation(scope, invocation)).toEqual(saved);
  });
});
