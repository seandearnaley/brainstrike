import type { DelegatedConversationIdentity } from '@brainstrike/agent';
import { migrate, runDrizzleMigrations, wasmLoader } from '@brainstrike/db';
import { createBrainstrikePglite } from '@brainstrike/db/pglite-factory';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDesktopDelegatedConversationHost } from '../../assistant-server/delegated-conversation-host';

describe('durable delegated tree admission', () => {
  let database: PGlite;

  beforeEach(async () => {
    database = await wasmLoader.createPGlite('memory://delegated-tree-limits');
    await migrate(database);
    await database.exec(`INSERT INTO mastra_threads
      (id, "resourceId", title, metadata, "createdAt", "updatedAt") VALUES
      ('root', 'owner', 'Root', '{}', NOW(), NOW());
      INSERT INTO brainstrike_assistant_thread_runs
      (id, resource_id, thread_id, provider, model, runtime_kind, status,
       started_at, created_at, updated_at, turn_message_id) VALUES
      ('initial-leg', 'owner', 'root', 'openai', 'test', 'desktop', 'running',
       NOW(), NOW(), NOW(), 'original-turn'),
      ('resume-leg', 'owner', 'root', 'openai', 'test', 'desktop', 'running',
       NOW(), NOW(), NOW(), 'original-turn'),
      ('next-turn-leg', 'owner', 'root', 'openai', 'test', 'desktop', 'running',
       NOW(), NOW(), NOW(), 'next-turn');`);
  }, 30_000);

  afterEach(async () => {
    await database.close();
  });

  async function childIdentity(
    childThreadId: string,
    parent?: DelegatedConversationIdentity
  ): Promise<DelegatedConversationIdentity> {
    const childResourceId = `resource-${childThreadId}`;
    await database.query(
      `INSERT INTO mastra_threads
       (id, "resourceId", title, metadata, "createdAt", "updatedAt")
       VALUES ($1, $2, 'Worker', '{}', NOW(), NOW())`,
      [childThreadId, childResourceId]
    );
    return {
      childResourceId,
      childThreadId,
      configuration: { maxSteps: 16, persona: { id: 'worker', mode: 'worker' } },
      parentResourceId: parent?.childResourceId ?? 'owner',
      parentRuntimeRunId: parent ? `native-${parent.childThreadId}` : 'native-root',
      parentThreadId: parent?.childThreadId ?? 'root',
      parentToolCallId: `call-${childThreadId}`,
      personaId: 'worker',
    };
  }

  async function expectNotAdmitted(identity: DelegatedConversationIdentity): Promise<void> {
    const invocation = await database.query(
      `SELECT thread_id FROM brainstrike_delegated_invocations
       WHERE root_thread_id = 'root' AND parent_runtime_run_id = $1
         AND parent_tool_call_id = $2`,
      [identity.parentRuntimeRunId, identity.parentToolCallId]
    );
    expect.soft(invocation.rows).toEqual([]);
    const conversation = await database.query(
      'SELECT thread_id FROM brainstrike_delegated_conversations WHERE thread_id = $1',
      [identity.childThreadId]
    );
    expect.soft(conversation.rows).toEqual([]);
  }

  it('does not silently replenish a legacy active child after migration', async () => {
    const identity = await childIdentity('legacy-child');
    const host = createDesktopDelegatedConversationHost(database, 'initial-leg');
    await host.persist(identity);
    await database.exec('DELETE FROM brainstrike_delegation_budgets');
    const resumed = createDesktopDelegatedConversationHost(database, 'resume-leg');
    await expect(
      resumed.budget.reserveStep({
        resourceId: identity.childResourceId,
        threadId: identity.childThreadId,
      })
    ).rejects.toThrow('Start a new parent turn');
    const newSibling = await childIdentity('legacy-sibling');
    await expect(resumed.persist(newSibling)).rejects.toThrow('Start a new parent turn');
    await expectNotAdmitted(newSibling);
    const budgets = await database.query('SELECT * FROM brainstrike_delegation_budgets');
    expect(budgets.rows).toEqual([]);
    const graph = await database.query('SELECT * FROM brainstrike_delegated_invocations');
    expect(graph.rows).toHaveLength(1);
  });

  it('admits three descendant levels and rejects the fourth without persisting partial admission', async () => {
    let parent: DelegatedConversationIdentity | undefined;
    for (const depth of [1, 2, 3]) {
      const identity = await childIdentity(`depth-${depth}`, parent);
      const host = createDesktopDelegatedConversationHost(database, 'initial-leg');
      await host.persist(identity);
      await host.bindRun({
        childRuntimeRunId: `native-${identity.childThreadId}`,
        parentRuntimeRunId: identity.parentRuntimeRunId,
        parentToolCallId: identity.parentToolCallId,
        personaId: identity.personaId,
      });
      parent = identity;
    }

    const fourth = await childIdentity('depth-4', parent);
    const resumedHost = createDesktopDelegatedConversationHost(database, 'resume-leg');
    await expect.soft(resumedHost.persist(fourth)).rejects.toThrow(/depth|level/i);
    await expectNotAdmitted(fourth);
    const admitted = await database.query(
      "SELECT thread_id FROM brainstrike_delegated_invocations WHERE root_thread_id = 'root'"
    );
    expect(admitted.rows).toHaveLength(3);
  });

  it('retains the eight-invocation original-turn limit through recreated hosts, duplicate persistence and resume', async () => {
    let first: DelegatedConversationIdentity | undefined;
    for (let index = 1; index <= 8; index += 1) {
      const identity = await childIdentity(`sibling-${index}`);
      const hostRunId = index <= 4 ? 'initial-leg' : 'resume-leg';
      await createDesktopDelegatedConversationHost(database, hostRunId).persist(identity);
      first ??= identity;
    }
    if (!first) {
      throw new Error('Expected the first admitted sibling');
    }
    // Replayed persistence identifies the same native invocation, not a ninth one.
    await createDesktopDelegatedConversationHost(database, 'initial-leg').persist(first);

    const ninth = await childIdentity('sibling-9');
    await expect
      .soft(createDesktopDelegatedConversationHost(database, 'resume-leg').persist(ninth))
      .rejects.toThrow(/invocation|total.*limit|limit.*total/i);
    await expectNotAdmitted(ninth);
    const admitted = await database.query(
      `SELECT thread_id FROM brainstrike_delegated_invocations
       WHERE root_thread_id = 'root' AND turn_message_id = 'original-turn'`
    );
    expect.soft(admitted.rows).toHaveLength(8);

    // The cap belongs to the original turn, not the conversation's entire lifetime.
    const nextTurn = await childIdentity('next-turn-child');
    await createDesktopDelegatedConversationHost(database, 'next-turn-leg').persist(nextTurn);
    const nextTurnInvocations = await database.query(
      `SELECT thread_id FROM brainstrike_delegated_invocations
       WHERE root_thread_id = 'root' AND turn_message_id = 'next-turn'`
    );
    expect(nextTurnInvocations.rows).toHaveLength(1);
  });
  it('admits at most eight racing siblings across independent hosts for the same original turn', async () => {
    const identities = await Promise.all(
      Array.from({ length: 12 }, (_, index) => childIdentity(`racing-${index}`))
    );
    const results = await Promise.allSettled(
      identities.map((identity, index) =>
        createDesktopDelegatedConversationHost(
          database,
          index % 2 ? 'resume-leg' : 'initial-leg'
        ).persist(identity)
      )
    );
    expect.soft(results.filter((result) => result.status === 'fulfilled')).toHaveLength(8);
    const rejected = results.flatMap((result, index) =>
      result.status === 'rejected' ? [index] : []
    );
    expect.soft(rejected).toHaveLength(4);
    for (const index of rejected) {
      const identity = identities[index];
      if (!identity) {
        throw new Error('Rejected sibling identity is missing');
      }
      await expectNotAdmitted(identity);
    }
    const admitted = await database.query(
      `SELECT thread_id FROM brainstrike_delegated_invocations
       WHERE root_thread_id = 'root' AND turn_message_id = 'original-turn'`
    );
    expect(admitted.rows).toHaveLength(8);
  });

  it('counts child steps across resume hosts and reserves exactly one final synthesis step', async () => {
    const child = await childIdentity('bounded-steps');
    const initial = createDesktopDelegatedConversationHost(database, 'initial-leg');
    await initial.persist(child);
    for (let index = 0; index < 16; index += 1) {
      const host = createDesktopDelegatedConversationHost(
        database,
        index % 2 ? 'resume-leg' : 'initial-leg'
      );
      const reservation = await host.budget.reserveStep({
        resourceId: child.childResourceId,
        threadId: child.childThreadId,
      });
      expect(reservation.synthesis).toBe(index === 15);
      await host.budget.settleStep(reservation.id, 1);
    }
    await expect(
      initial.budget.reserveStep({
        resourceId: child.childResourceId,
        threadId: child.childThreadId,
      })
    ).rejects.toThrow(/step|synthesis|budget/i);
  });

  it('charges unknown generation usage and permits only reserved synthesis after child output exhaustion', async () => {
    const child = await childIdentity('bounded-output');
    const host = createDesktopDelegatedConversationHost(database, 'initial-leg');
    await host.persist(child);
    const scope = { resourceId: child.childResourceId, threadId: child.childThreadId };
    let allocated = 0;
    for (let index = 0; index < 5; index += 1) {
      const reservation = await host.budget.reserveStep(scope);
      allocated += reservation.outputTokens;
      expect(reservation.synthesis).toBe(index === 4);
      // Unknown usage and interrupted reservations retain the whole authorized allocation.
      if (index % 2) {
        await host.budget.settleStep(reservation.id, undefined);
      }
    }
    expect(allocated).toBe(32_768);
    await expect(
      createDesktopDelegatedConversationHost(database, 'resume-leg').budget.reserveStep(scope)
    ).rejects.toThrow(/budget|synthesis/i);
  });

  it('does not refund admission after a child is deleted or admit after root cancellation', async () => {
    for (let index = 0; index < 8; index += 1) {
      const child = await childIdentity(`deleted-${index}`);
      await createDesktopDelegatedConversationHost(database, 'initial-leg').persist(child);
      await database.query('DELETE FROM mastra_threads WHERE id = $1', [child.childThreadId]);
    }
    const ninth = await childIdentity('deleted-ninth');
    await expect(
      createDesktopDelegatedConversationHost(database, 'resume-leg').persist(ninth)
    ).rejects.toThrow(/invocation/i);
    await expectNotAdmitted(ninth);
    await database.query(
      "UPDATE brainstrike_assistant_thread_runs SET status = 'cancelled' WHERE id = 'next-turn-leg'"
    );
    const cancelled = await childIdentity('cancelled-child');
    await expect(
      createDesktopDelegatedConversationHost(database, 'next-turn-leg').persist(cancelled)
    ).rejects.toMatchObject({ reason: 'delegation-root-not-running' });
    await expectNotAdmitted(cancelled);
  });

  it('reserves the shared token ceiling under sibling races while preserving each admitted summary', async () => {
    const host = createDesktopDelegatedConversationHost(database, 'initial-leg');
    const children = await Promise.all(
      Array.from({ length: 8 }, (_, index) => childIdentity(`token-race-${index}`))
    );
    for (const child of children) {
      await host.persist(child);
    }
    const scopes = children.map((child) => ({
      resourceId: child.childResourceId,
      threadId: child.childThreadId,
    }));
    for (let round = 0; round < 2; round += 1) {
      const reservations = await Promise.all(scopes.map((scope) => host.budget.reserveStep(scope)));
      expect(reservations.every((reservation) => !reservation.synthesis)).toBe(true);
    }
    const summaries = await Promise.all(scopes.map((scope) => host.budget.reserveStep(scope)));
    expect(
      summaries.every((reservation) => reservation.synthesis && reservation.outputTokens === 512)
    ).toBe(true);
    const rows = await database.query<{ charged_output_tokens: number }>(
      'SELECT charged_output_tokens FROM brainstrike_delegation_budgets'
    );
    expect(rows.rows[0]?.charged_output_tokens).toBe(131_072);
    for (const scope of scopes) {
      await expect(host.budget.reserveStep(scope)).rejects.toThrow(/synthesis/);
    }
  });

  it('commits an observed overage exactly once before rejecting further tool execution', async () => {
    const child = await childIdentity('overage');
    const host = createDesktopDelegatedConversationHost(database, 'initial-leg');
    await host.persist(child);
    const reservation = await host.budget.reserveStep({
      resourceId: child.childResourceId,
      threadId: child.childThreadId,
    });
    await expect(host.budget.settleStep(reservation.id, 8193)).rejects.toThrow(/Provider exceeded/);
    const rows = await database.query<{ charged_output_tokens: number }>(
      'SELECT charged_output_tokens FROM brainstrike_delegation_budgets'
    );
    expect(rows.rows[0]?.charged_output_tokens).toBe(8193 + 512);
    await expect(host.budget.settleStep(reservation.id, 0)).rejects.toThrow(
      'already settled or does not belong to this host turn'
    );
    expect(
      (await database.query('SELECT charged_output_tokens FROM brainstrike_delegation_budgets'))
        .rows
    ).toEqual(rows.rows);
  });

  it('preserves consumed and unresolved allocations after loading the database in a new engine', async () => {
    const child = await childIdentity('restart-budget');
    const host = createDesktopDelegatedConversationHost(database, 'initial-leg');
    await host.persist(child);
    const scope = { resourceId: child.childResourceId, threadId: child.childThreadId };
    await host.budget.reserveStep(scope);
    const snapshot = await database.dumpDataDir('none');
    await database.close();
    database = await createBrainstrikePglite({ loadDataDir: snapshot });
    const resumed = createDesktopDelegatedConversationHost(database, 'resume-leg');
    const reservation = await resumed.budget.reserveStep(scope);
    expect(reservation.outputTokens).toBe(8192);
    expect(
      (
        await database.query(
          'SELECT steps, charged_output_tokens FROM brainstrike_delegation_child_budgets'
        )
      ).rows
    ).toEqual([{ charged_output_tokens: 16_384 + 512, steps: 2 }]);
    await resumed.budget.settleStep(reservation.id, 1);
    expect(
      (
        await database.query(
          'SELECT steps, charged_output_tokens FROM brainstrike_delegation_child_budgets'
        )
      ).rows
    ).toEqual([{ charged_output_tokens: 8193 + 512, steps: 2 }]);
  });

  it('upgrades the existing native graph once and replays without resetting budgets', async () => {
    await database.exec(
      'DROP TABLE brainstrike_delegation_step_reservations; DROP TABLE brainstrike_delegation_child_budgets; DROP TABLE brainstrike_delegation_budgets'
    );
    await database.query(
      "DELETE FROM __drizzle_migrations WHERE hash = 'custom-132-delegation-budgets'"
    );
    const upgraded = await runDrizzleMigrations(database);
    expect(upgraded.success).toBe(true);
    expect(upgraded.appliedMigrations).toHaveLength(1);
    const child = await childIdentity('upgrade-child');
    const host = createDesktopDelegatedConversationHost(database, 'initial-leg');
    await host.persist(child);
    await host.budget.reserveStep({
      resourceId: child.childResourceId,
      threadId: child.childThreadId,
    });
    const before = await database.query('SELECT * FROM brainstrike_delegation_budgets');
    expect(await runDrizzleMigrations(database)).toEqual({ appliedMigrations: [], success: true });
    expect((await database.query('SELECT * FROM brainstrike_delegation_budgets')).rows).toEqual(
      before.rows
    );
  });
});
