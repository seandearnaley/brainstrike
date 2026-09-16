/**
 * Swarm diagnostics evidence and host-answered decisions through the REAL
 * desktop host and ledger (migration 139): the debug-pack rows a leg records,
 * the coded log a failed record leaves behind, and the all-or-none answer
 * batch. The rest of the host authority suite is
 * `delegated-conversation-host.integration.test.ts`.
 */

import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDesktopDelegatedConversationHost } from '../../assistant-server/delegated-conversation-host';
import { desktopAssistantServerLogger as logger } from '../../assistant-server/logger';
import { createBudgetedHost } from './fixtures/budgeted-host';
import { createHostDatabase, identity, run } from './fixtures/delegated-host-fixtures';

describe('desktop delegated diagnostics and answer batches', () => {
  let database: PGlite;
  beforeEach(async () => {
    database = await createHostDatabase('memory://delegated-host-diagnostics');
  }, 30_000);

  afterEach(async () => {
    await database.close();
  });

  it('records wakeups, prompt manifests and live decisions under the host run', async () => {
    const host = createDesktopDelegatedConversationHost(database, 'initial-leg');
    await host.recordWakeup({
      directive: 'All 1 background invocations have finished.',
      invocations: [
        {
          outcome: 'completed',
          taskId: 't1',
          toolCallId: 'parent-call',
          toolName: 'agent-explore',
        },
      ],
      kind: 'idle-loop',
    });
    await host.recordPromptManifest({
      kind: 'root-leg',
      systemContextSource: 'captured',
      systemMessages: [{ content: 'You are Brainstrike.', role: 'system' }],
      threadId: 'root',
      toolNames: ['brainstrike.grepSearch'],
    });
    await host.recordLiveDecision({
      kind: 'approval',
      outcome: 'remembered-answered',
      source: 'remembered-grant',
      taskId: 't2',
      toolCallId: 'child-call',
    });
    expect((await database.query('SELECT kind FROM brainstrike_delegated_wakeups')).rows).toEqual([
      { kind: 'idle-loop' },
    ]);
    expect(
      (await database.query('SELECT kind, thread_id FROM brainstrike_assistant_prompt_manifests'))
        .rows
    ).toEqual([{ kind: 'root-leg', thread_id: 'root' }]);
    expect(
      (await database.query('SELECT outcome, source FROM brainstrike_delegated_live_decisions'))
        .rows
    ).toEqual([{ outcome: 'remembered-answered', source: 'remembered-grant' }]);
  });

  it('logs and continues when a diagnostic record has no live host run or fails to persist', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const host = createDesktopDelegatedConversationHost(database, 'ghost-leg');
    await expect(
      host.recordWakeup({ directive: 'x', invocations: [], kind: 'deferred' })
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      'Swarm diagnostic record has no host run',
      expect.objectContaining({
        code: 'swarm_diagnostic_record_run_missing',
        hostRunId: 'ghost-leg',
        record: 'wakeup',
      })
    );
    // A failed write is logged with its own code, never reported as success,
    // and never rejects into the leg (ruling 4).
    const failing = createDesktopDelegatedConversationHost(
      {
        query: async () => {
          throw new Error('disk full');
        },
      },
      'initial-leg'
    );
    await expect(
      failing.recordLiveDecision({
        kind: 'approval',
        outcome: 'delivered',
        source: 'user',
        toolCallId: 'call',
      })
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      'Swarm diagnostic record failed to persist',
      expect.objectContaining({
        code: 'swarm_diagnostic_record_failed',
        hostRunId: 'initial-leg',
        record: 'live-decision',
      })
    );
    error.mockRestore();
  });

  it('names ONE reason per leaf: stopped wins over answered, and a stop on another turn is not read', async () => {
    // PR #3221 review: a leaf that is BOTH answered and stopped used to yield
    // two rows, and which survived depended on `ORDER BY reason` plus how the
    // caller folded duplicates — neither visible at the consuming site. The
    // query now picks the reason itself (`DISTINCT ON … reason DESC`).
    const host = createBudgetedHost(database, 'initial-leg');
    await host.persist(identity);
    await host.bindRun(run);
    const candidate = {
      childRuntimeRunId: run.childRuntimeRunId,
      threadIds: [identity.childThreadId],
      toolCallId: 'read-1',
    };
    const leaf = (reason: 'answered' | 'stopped') => [
      { childRuntimeRunId: run.childRuntimeRunId, reason, toolCallId: candidate.toolCallId },
    ];
    expect(await host.readUnanswerableToolActionLeaves([candidate])).toEqual([]);
    await host.recordToolActionAnswers([
      {
        delegation: { path: [run], toolCallId: candidate.toolCallId },
        runId: run.parentRuntimeRunId,
        toolCallId: run.parentToolCallId,
      },
    ]);
    expect(await host.readUnanswerableToolActionLeaves([candidate])).toEqual(leaf('answered'));
    await database.query(
      'UPDATE brainstrike_delegated_invocations SET cancellation_requested_at = NOW() WHERE thread_id = $1',
      [identity.childThreadId]
    );
    // MUTATION GUARD: without the query's own precedence this is two rows, or
    // one still carrying 'answered'.
    expect(await host.readUnanswerableToolActionLeaves([candidate])).toEqual(leaf('stopped'));
    // The stop belongs to `user-turn`, so a leg on another turn cannot read it
    // — the same turn scoping the answer write refuses on. The ANSWERED arm is
    // deliberately not turn-scoped, matching the unique leaf key, so it stays.
    expect(
      await createBudgetedHost(database, 'other-turn-leg').readUnanswerableToolActionLeaves([
        candidate,
      ])
    ).toEqual(leaf('answered'));
  });

  it('refuses a batch that answers the same leaf twice and records nothing', async () => {
    // BST-1749, PR #3209 review: the batch is built as `[explicit, ...granted]`
    // with no dedupe, so one write could carry the same leaf twice — the second
    // row hit the unique leaf key and rolled back the user's own answer under a
    // reason that reads like a concurrent answer.
    const host = createBudgetedHost(database, 'initial-leg');
    await host.persist(identity);
    await host.bindRun(run);
    const answer = {
      delegation: { path: [run], toolCallId: 'read-1' },
      runId: run.parentRuntimeRunId,
      toolCallId: run.parentToolCallId,
    };
    await expect(host.recordToolActionAnswers([answer, answer])).rejects.toMatchObject({
      reason: 'tool-action-answer-duplicate',
    });
    expect(
      (await database.query('SELECT id FROM brainstrike_delegated_tool_decisions')).rows
    ).toEqual([]);
    // The same leaf answered once still records.
    await expect(host.recordToolActionAnswers([answer])).resolves.toBeUndefined();
  });
});
