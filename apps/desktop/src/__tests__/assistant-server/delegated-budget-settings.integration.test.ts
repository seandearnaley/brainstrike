import type { DelegatedConversationIdentity } from '@brainstrike/agent';
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
    maxSteps: number
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
      parentResourceId: 'owner',
      parentRuntimeRunId: 'native-root',
      parentThreadId: 'root',
      parentToolCallId: `call-${childThreadId}`,
      personaId: 'explore',
    };
  }

  const settings = {
    maxChildOutputTokens: 16_384,
    maxChildSteps: 6,
    maxStepOutputTokens: 4096,
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
        max_depth: 3,
        max_invocations: 8,
        max_output_tokens: 131_072,
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

  it('the defaults open a 32-step / 2048-token synthesis row', async () => {
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
    expect(rows.rows).toEqual([{ max_child_steps: 32, synthesis_output_tokens: 2048 }]);
  });
});
