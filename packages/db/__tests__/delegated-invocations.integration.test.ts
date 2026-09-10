import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/drizzle/migrate.js';
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

  it('upgrades through the production migration ledger and replays without changing invocation identity', async () => {
    await database.exec('DROP TABLE brainstrike_delegated_invocations');
    await database.query(
      "DELETE FROM __drizzle_migrations WHERE hash = 'custom-127-delegated-invocations'"
    );
    expect(await runMigrations(database)).toMatchObject({
      appliedMigrations: [expect.anything()],
      success: true,
    });
    const repository = createDelegatedConversationRepository(database);
    const saved = await repository.createInvocation(scope, invocation);
    expect(await runMigrations(database)).toEqual({ appliedMigrations: [], success: true });
    expect(await repository.getInvocation(scope, invocation)).toEqual(saved);
  });
});
