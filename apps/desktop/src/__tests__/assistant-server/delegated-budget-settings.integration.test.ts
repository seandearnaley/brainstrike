import type { DelegatedConversationIdentity } from '@brainstrike/agent';
import { DelegatedOutputReservationExceededError } from '@brainstrike/assistant-contract';
import { DEFAULT_RUNTIME_SUBAGENT_SETTINGS } from '@brainstrike/assistant-contract/subagent-settings';
import { migrate, wasmLoader } from '@brainstrike/db';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDesktopDelegatedConversationHost } from '../../assistant-server/delegated-conversation-host';

describe('delegation budgets from RuntimeSubagentSettings', () => {
  let database: PGlite;

  beforeEach(async () => {
    database = await wasmLoader.createPGlite('memory://delegated-budget-settings');
    await migrate(database);
    await database.exec(`INSERT INTO mastra_threads
      (id, "resourceId", title, metadata, "createdAt", "updatedAt") VALUES
      ('root', 'owner', 'Root', '{}', NOW(), NOW());
      INSERT INTO brainstrike_assistant_thread_runs
      (id, resource_id, thread_id, provider, model, runtime_kind, status,
       started_at, created_at, updated_at, turn_message_id) VALUES
      ('leg', 'owner', 'root', 'openai', 'test', 'desktop', 'running', NOW(), NOW(), NOW(), 'turn'),
      ('later-leg', 'owner', 'root', 'openai', 'test', 'desktop', 'running', NOW(), NOW(), NOW(), 'turn');`);
  }, 30_000);

  afterEach(async () => {
    await database.close();
  });

  async function child(
    childThreadId: string,
    maxSteps: number,
    parent?: DelegatedConversationIdentity
  ): Promise<DelegatedConversationIdentity> {
    const childResourceId = `resource-${childThreadId}`;
    await database.query(
      `INSERT INTO mastra_threads (id, "resourceId", title, metadata, "createdAt", "updatedAt")
       VALUES ($1, $2, 'Explorer', '{}', NOW(), NOW())`,
      [childThreadId, childResourceId]
    );
    return {
      childResourceId,
      childThreadId,
      configuration: { maxSteps, persona: { id: 'explore' } },
      parentResourceId: parent?.childResourceId ?? 'owner',
      parentRuntimeRunId: parent ? `native-${parent.childThreadId}` : 'native-root',
      parentThreadId: parent?.childThreadId ?? 'root',
      parentToolCallId: `call-${childThreadId}`,
      personaId: 'explore',
    };
  }

  // Every value differs from the defaults, so a constant read anywhere shows.
  const settings = {
    maxChildOutputTokens: 16_384,
    maxChildRuntimeMs: null,
    maxChildSteps: 6,
    maxConcurrentWork: 4,
    maxDepth: 2,
    maxInvocations: 5,
    maxStepOutputTokens: 4096,
    maxTreeOutputTokens: 65_536,
    synthesisOutputTokens: 1024,
  };

  it('opens the turn budget row from the request settings, not from a constant', async () => {
    const host = createDesktopDelegatedConversationHost(
      database,
      'leg',
      undefined,
      undefined,
      settings
    );
    await host.persist(await child('explorer', 32));
    const rows = await database.query<Record<string, number>>(
      `SELECT max_child_steps, max_child_output_tokens, max_step_output_tokens, synthesis_output_tokens,
              max_depth, max_invocations, max_output_tokens
       FROM brainstrike_delegation_budgets WHERE root_thread_id = 'root'`
    );
    expect(rows.rows).toEqual([
      {
        max_child_output_tokens: 16_384,
        max_child_steps: 6,
        max_depth: 2,
        max_invocations: 5,
        max_output_tokens: 65_536,
        max_step_output_tokens: 4096,
        synthesis_output_tokens: 1024,
      },
    ]);
    const childRow = await database.query<{ max_steps: number; charged_output_tokens: number }>(
      "SELECT max_steps, charged_output_tokens FROM brainstrike_delegation_child_budgets WHERE child_thread_id = 'explorer'"
    );
    // The persona declared 32; the setting (6) is the ceiling; synthesis (1024) is precharged.
    expect(childRow.rows).toEqual([{ charged_output_tokens: 1024, max_steps: 6 }]);
  });

  it("refuses the invocation past the request's per-turn limit, at start and at persist", async () => {
    const host = createDesktopDelegatedConversationHost(database, 'leg', undefined, undefined, {
      ...settings,
      maxInvocations: 2,
    });
    const root = { parentResourceId: 'owner', parentThreadId: 'root' };
    await host.persist(await child('first-of-two', 32));
    await host.persist(await child('second-of-two', 32));
    const refusal = 'Delegation invocation limit reached (2 per original turn).';
    await expect(host.budget.admitInvocation(root)).resolves.toEqual({
      admitted: false,
      reason: refusal,
    });
    await expect(host.persist(await child('third-of-two', 32))).rejects.toThrow(refusal);
  });

  it("refuses a descendant below the request's depth limit", async () => {
    const host = createDesktopDelegatedConversationHost(database, 'leg', undefined, undefined, {
      ...settings,
      maxDepth: 1,
    });
    const first = await child('level-one', 32);
    await host.persist(first);
    await expect(
      host.budget.admitInvocation({
        parentResourceId: first.childResourceId,
        parentThreadId: first.childThreadId,
      })
    ).resolves.toEqual({
      admitted: false,
      reason: 'Delegation depth limit reached (1 descendant levels).',
    });
    await expect(host.persist(await child('level-two', 32, first))).rejects.toThrow(
      'Delegation depth limit reached (1 descendant levels).'
    );
  });

  it("names the tree-output cap at the request's tree budget, before any child's own", async () => {
    const host = createDesktopDelegatedConversationHost(database, 'leg', undefined, undefined, {
      ...settings,
      maxChildOutputTokens: 1024,
      maxStepOutputTokens: 512,
      maxTreeOutputTokens: 1536,
      synthesisOutputTokens: 256,
    });
    const alpha = await child('tree-alpha', 32);
    const beta = await child('tree-beta', 32);
    await host.persist(alpha);
    await host.persist(beta);
    const scopeOf = (identity: DelegatedConversationIdentity) => ({
      resourceId: identity.childResourceId,
      threadId: identity.childThreadId,
    });
    // Precharged summaries 2 x 256, then Alpha 512 + 256 and Beta 256 fill 1,536.
    await host.budget.reserveStep(scopeOf(alpha));
    await host.budget.reserveStep(scopeOf(alpha));
    await expect(host.budget.reserveStep(scopeOf(beta))).resolves.toMatchObject({
      outputTokens: 256,
      synthesis: false,
    });
    // Beta has spent 512 of its 1,024: the TREE is what is exhausted.
    await expect(host.budget.reserveStep(scopeOf(beta))).resolves.toMatchObject({
      cap: 'tree-output',
      limit: 1536,
      synthesis: true,
      used: 1536,
    });
    await expect(
      host.budget.admitInvocation({ parentResourceId: 'owner', parentThreadId: 'root' })
    ).resolves.toEqual({
      admitted: false,
      reason: 'Delegation output budget cannot reserve a child summary.',
    });
  });

  it('reserves steps and the synthesis step from the stored settings, naming the cap', async () => {
    const host = createDesktopDelegatedConversationHost(
      database,
      'leg',
      undefined,
      undefined,
      settings
    );
    const identity = await child('stepper', 32);
    await host.persist(identity);
    const scope = { resourceId: identity.childResourceId, threadId: identity.childThreadId };
    for (let index = 0; index < 5; index += 1) {
      const reservation = await host.budget.reserveStep(scope);
      expect(reservation).toEqual({ id: expect.any(String), outputTokens: 4096, synthesis: false });
      await host.budget.settleStep(reservation.id, 100);
    }
    const synthesis = await host.budget.reserveStep(scope);
    // The cap names its numbers: 5 of 6 steps used when the summary is forced.
    expect(synthesis).toEqual({
      cap: 'steps',
      id: expect.any(String),
      limit: 6,
      outputTokens: 1024,
      synthesis: true,
      used: 5,
    });
    await expect(host.budget.reserveStep(scope)).rejects.toThrow(/synthesis/);
  });

  it('charges an over-budget final summary once and refuses all later child work', async () => {
    const host = createDesktopDelegatedConversationHost(database, 'leg', undefined, undefined, {
      ...settings,
      maxChildSteps: 2,
    });
    const identity = await child('summary-overage', 32);
    await host.persist(identity);
    const scope = { resourceId: identity.childResourceId, threadId: identity.childThreadId };
    const working = await host.budget.reserveStep(scope);
    await host.budget.settleStep(working.id, 1);
    const summary = await host.budget.reserveStep(scope);
    expect(summary).toMatchObject({ outputTokens: 1024, synthesis: true });
    await expect(host.budget.settleStep(summary.id, 1999)).rejects.toBeInstanceOf(
      DelegatedOutputReservationExceededError
    );
    await expect(host.budget.reserveStep(scope)).rejects.toThrow(/synthesis/);
    await expect(host.budget.settleStep(summary.id, 0)).rejects.toThrow(/already settled/);
    for (const table of [
      'brainstrike_delegation_budgets',
      'brainstrike_delegation_child_budgets',
    ]) {
      const rows = await database.query<{ charged_output_tokens: number }>(
        `SELECT charged_output_tokens FROM ${table}`
      );
      expect(rows.rows).toEqual([{ charged_output_tokens: 2000 }]);
    }
  });

  it('names the child-output cap when the child, not the tree, is exhausted', async () => {
    const host = createDesktopDelegatedConversationHost(database, 'leg', undefined, undefined, {
      ...settings,
      maxChildOutputTokens: 8192,
      maxChildSteps: 40,
      maxStepOutputTokens: 4096,
    });
    const identity = await child('spender', 40);
    await host.persist(identity);
    const scope = { resourceId: identity.childResourceId, threadId: identity.childThreadId };
    // 1024 precharged synthesis + 4096 + (remaining 3072) exhausts 8192.
    await host.budget.reserveStep(scope);
    await host.budget.reserveStep(scope);
    await expect(host.budget.reserveStep(scope)).resolves.toMatchObject({
      cap: 'child-output',
      limit: 8192,
      synthesis: true,
      used: 8192,
    });
  });

  it("a later leg reads the turn's limits from the row, never its own different request", async () => {
    const first = createDesktopDelegatedConversationHost(
      database,
      'leg',
      undefined,
      undefined,
      settings
    );
    // Before the first admission the turn has no row: the leg uses its request.
    await expect(first.budget.readTurnLimits()).resolves.toBeUndefined();
    await first.persist(await child('opened', 32));
    const later = createDesktopDelegatedConversationHost(
      database,
      'later-leg',
      undefined,
      undefined,
      { ...settings, maxDepth: 6, maxInvocations: 1, maxTreeOutputTokens: 1_000_000 }
    );
    await expect(later.budget.readTurnLimits()).resolves.toEqual({
      maxChildOutputTokens: 16_384,
      maxChildSteps: 6,
      maxDepth: 2,
      maxInvocations: 5,
      maxStepOutputTokens: 4096,
      maxTreeOutputTokens: 65_536,
      synthesisOutputTokens: 1024,
    });
  });

  it('a later leg on the same turn reads the stored row even without settings', async () => {
    await createDesktopDelegatedConversationHost(
      database,
      'leg',
      undefined,
      undefined,
      settings
    ).persist(await child('first', 32));
    const later = createDesktopDelegatedConversationHost(database, 'later-leg');
    await later.persist(await child('second', 32));
    const rows = await database.query<{ max_steps: number }>(
      "SELECT max_steps FROM brainstrike_delegation_child_budgets WHERE child_thread_id = 'second'"
    );
    expect(rows.rows).toEqual([{ max_steps: 6 }]);
  });

  it('refuses to open a budget row without settings instead of inventing one', async () => {
    const host = createDesktopDelegatedConversationHost(database, 'leg');
    await expect(host.persist(await child('orphan', 32))).rejects.toThrow(
      /no delegation budget yet/
    );
    expect((await database.query('SELECT 1 FROM brainstrike_delegation_budgets')).rows).toEqual([]);
  });

  it('the defaults open a 100-step / 2048-token synthesis row', async () => {
    const host = createDesktopDelegatedConversationHost(
      database,
      'leg',
      undefined,
      undefined,
      DEFAULT_RUNTIME_SUBAGENT_SETTINGS
    );
    await host.persist(await child('default', 32));
    const rows = await database.query<Record<string, number>>(
      "SELECT max_child_steps, synthesis_output_tokens FROM brainstrike_delegation_budgets WHERE root_thread_id = 'root'"
    );
    expect(rows.rows).toEqual([{ max_child_steps: 100, synthesis_output_tokens: 2048 }]);
  });
});
