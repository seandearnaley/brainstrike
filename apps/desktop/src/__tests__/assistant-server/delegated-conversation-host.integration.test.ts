import type {
  DelegatedConversationIdentity,
  DelegatedRunIdentity,
  StreamChunk,
} from '@brainstrike/agent';
import {
  createAssistantThreadHistoryAdapter,
  createPgliteAssistantThreadRepository,
} from '@brainstrike/assistant-data';
import { createDelegatedConversationRepository, migrate, wasmLoader } from '@brainstrike/db';
import type { DbHandle } from '@brainstrike/db/react';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDesktopDelegatedConversationHost } from '../../assistant-server/delegated-conversation-host';
import { readDelegatedDecisionStates } from '../../assistant-server/delegated-decision-discovery';
import { desktopAssistantServerLogger as logger } from '../../assistant-server/logger';
import {
  observeDesktopAssistantRunEvents,
  persistDesktopChildRunUsage,
} from '../../assistant-server/run-persistence';
import { reapOrphanedThreadRuns } from '../../assistant-server/thread-run-startup-reaper';
import { createBudgetedHost } from './fixtures/budgeted-host';

describe('desktop delegated conversation authority', () => {
  let database: PGlite;
  const scope = { ownerResourceId: 'owner', rootThreadId: 'root' };
  const identity: DelegatedConversationIdentity = {
    childResourceId: 'native-child-owner',
    childThreadId: 'child',
    configuration: { maxSteps: 16, persona: { id: 'explore' } },
    parentResourceId: 'owner',
    parentRuntimeRunId: 'parent-native-run',
    parentThreadId: 'root',
    parentToolCallId: 'parent-call',
    personaId: 'explore',
  };
  const run: DelegatedRunIdentity = {
    childRuntimeRunId: 'child-native-run',
    parentRuntimeRunId: identity.parentRuntimeRunId,
    parentToolCallId: identity.parentToolCallId,
    personaId: identity.personaId,
  };

  beforeEach(async () => {
    database = await wasmLoader.createPGlite('memory://delegated-host');
    await migrate(database);
    await database.exec(`INSERT INTO mastra_threads
      (id, "resourceId", title, metadata, "createdAt", "updatedAt") VALUES
      ('root', 'owner', 'Root', '{}', NOW(), NOW()),
      ('other', 'owner', 'Other root', '{}', NOW(), NOW()),
      ('child', 'native-child-owner', 'Child', '{}', NOW(), NOW()),
      ('sibling', 'native-sibling-owner', 'Sibling', '{}', NOW(), NOW());
      INSERT INTO brainstrike_assistant_thread_runs
      (id, resource_id, thread_id, provider, model, runtime_kind, status,
       started_at, created_at, updated_at, turn_message_id) VALUES
      ('initial-leg', 'owner', 'root', 'openai', 'test', 'desktop', 'running',
       NOW(), NOW(), NOW(), 'user-turn'),
      ('resume-leg', 'owner', 'root', 'openai', 'test', 'desktop', 'running',
       NOW(), NOW(), NOW(), 'user-turn'),
      ('other-turn-leg', 'owner', 'root', 'openai', 'test', 'desktop', 'running',
       NOW(), NOW(), NOW(), 'other-turn'),
      ('other-root-leg', 'owner', 'other', 'openai', 'test', 'desktop', 'running',
       NOW(), NOW(), NOW(), 'user-turn');`);
  }, 30_000);

  afterEach(async () => {
    await database.close();
  });

  async function persistUsage(
    value: Extract<StreamChunk, { type: 'child-run-usage' }>['value'],
    hostRunId = 'initial-leg'
  ): Promise<void> {
    async function* source(): AsyncIterable<StreamChunk> {
      yield { type: 'child-run-usage', value };
    }
    for await (const chunk of persistDesktopChildRunUsage(
      source(),
      hostRunId,
      undefined,
      async () => database,
      true
    )) {
      expect(chunk.type).toBe('child-run-usage');
    }
  }

  const usage = {
    delegation: {
      parentRuntimeRunId: identity.parentRuntimeRunId,
      parentToolCallId: identity.parentToolCallId,
      resourceId: identity.childResourceId,
      threadId: identity.childThreadId,
    },
    estimated: false,
    inputTokens: 5,
    outputTokens: 3,
    personaId: 'explore',
    source: 'subagent',
  } as const;

  const childStarted = {
    id: 'child-start',
    kind: 'run.started',
    label: 'Child started',
    status: 'running',
    timestamp: '2026-09-10T01:00:00.000Z',
  } as const;

  it.each(
    ([1, 2] as const).flatMap((depth) =>
      (['claimed', 'consumed', 'interrupted'] as const).map((state) => ({ depth, state }))
    )
  )(
    'rediscovers $state admission at depth $depth for its exact native leaf without crossing owner/root/call scope',
    async ({ depth, state }) => {
      const host = createBudgetedHost(database, 'initial-leg');
      await host.persist(identity);
      await host.bindRun(run);
      const path = [run];
      if (depth === 2) {
        const grandchild = {
          ...identity,
          childResourceId: 'native-sibling-owner',
          childThreadId: 'sibling',
          parentResourceId: identity.childResourceId,
          parentRuntimeRunId: run.childRuntimeRunId,
          parentThreadId: identity.childThreadId,
          parentToolCallId: 'grandchild-call',
        };
        const grandchildRun = {
          ...run,
          childRuntimeRunId: 'grandchild-run',
          parentRuntimeRunId: grandchild.parentRuntimeRunId,
          parentToolCallId: grandchild.parentToolCallId,
        };
        await host.persist(grandchild);
        await host.bindRun(grandchildRun);
        path.push(grandchildRun);
      }
      const action = {
        delegation: { path, toolCallId: 'read-1' },
        runId: run.parentRuntimeRunId,
        toolCallId: run.parentToolCallId,
      };
      await host.claimToolAction(action);
      if (state === 'consumed') {
        await host.finishToolActions();
      }
      if (state === 'interrupted') {
        await database.query(
          "UPDATE brainstrike_assistant_thread_runs SET started_at = '2020-01-01' WHERE id = 'initial-leg'"
        );
        await reapOrphanedThreadRuns(database, new Date());
      }
      const key = JSON.stringify([path.at(-1)?.childRuntimeRunId, 'read-1']);
      expect(await readDelegatedDecisionStates(database, scope, [action])).toEqual(
        new Map([[key, state]])
      );
      expect(
        await readDelegatedDecisionStates(
          database,
          { ...scope, ownerResourceId: 'another-owner' },
          [action]
        )
      ).toEqual(new Map());
      expect(
        await readDelegatedDecisionStates(database, { ...scope, rootThreadId: 'other' }, [action])
      ).toEqual(new Map());
      expect(
        await readDelegatedDecisionStates(database, scope, [
          { ...action, delegation: { ...action.delegation, toolCallId: 'next-leaf' } },
        ])
      ).toEqual(new Map());
      expect(
        await readDelegatedDecisionStates(database, scope, [
          { ...action, toolCallId: 'other-parent-call' },
        ])
      ).toEqual(new Map());
      expect(
        (await database.query('SELECT state FROM brainstrike_delegated_tool_decisions')).rows
      ).toEqual([{ state }]);
    }
  );

  it('logs the identity reason at the host boundary when admission is refused (BST-1751)', async () => {
    const diagnostic = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    try {
      const host = createBudgetedHost(database, 'initial-leg');
      await expect(
        host.persist({ ...identity, parentResourceId: 'someone-else' })
      ).rejects.toMatchObject({ reason: 'parent-scope-mismatch' });
      expect(diagnostic).toHaveBeenCalledWith(
        'Delegated conversation identity rejected',
        expect.objectContaining({
          code: 'delegated_conversation_identity_rejected',
          hostRunId: 'initial-leg',
          method: 'persist',
          reason: 'parent-scope-mismatch',
        })
      );
    } finally {
      diagnostic.mockRestore();
    }
  });

  it('loads only the requested leaf admission, not retained history for the same child run', async () => {
    const host = createBudgetedHost(database, 'initial-leg');
    await host.persist(identity);
    await host.bindRun(run);
    const action = {
      delegation: { path: [run], toolCallId: 'current' },
      runId: run.parentRuntimeRunId,
      toolCallId: run.parentToolCallId,
    };
    for (const toolCallId of ['historical', 'current']) {
      await host.claimToolAction({ ...action, delegation: { ...action.delegation, toolCallId } });
      await host.finishToolActions();
    }
    const query = vi.fn(async (sql: string, parameters?: readonly unknown[]) =>
      database.query(sql, parameters ? [...parameters] : undefined)
    );
    expect(await readDelegatedDecisionStates({ query }, scope, [action, action])).toEqual(
      new Map([[JSON.stringify([run.childRuntimeRunId, 'current']), 'consumed']])
    );
    expect(query).toHaveBeenCalledTimes(1);
    const result = await query.mock.results[0]?.value;
    expect(result?.rows).toHaveLength(1);
    expect(result?.rows).toMatchObject([{ leafToolCallId: 'current' }]);
  });

  it('claims a leaf decision once and serializes sibling resumes across recreated hosts', async () => {
    const first = createBudgetedHost(database, 'initial-leg');
    const second = createBudgetedHost(database, 'resume-leg');
    await first.persist(identity);
    await first.bindRun(run);
    const action = {
      delegation: { path: [run], toolCallId: 'read-1' },
      runId: run.parentRuntimeRunId,
      toolCallId: run.parentToolCallId,
    };
    const results = await Promise.allSettled([
      first.claimToolAction(action),
      second.claimToolAction(action),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const siblingIdentity = {
      ...identity,
      childResourceId: 'native-sibling-owner',
      childThreadId: 'sibling',
      parentToolCallId: 'sibling-call',
    };
    const siblingRun = {
      ...run,
      childRuntimeRunId: 'sibling-run',
      parentToolCallId: 'sibling-call',
    };
    await first.persist(siblingIdentity);
    await first.bindRun(siblingRun);
    const next = {
      ...action,
      delegation: { path: [siblingRun], toolCallId: 'read-1' },
      toolCallId: siblingRun.parentToolCallId,
    };
    await expect(second.claimToolAction(next)).rejects.toThrow();
    // An unrelated recreated host cannot release the successful claimant.
    await createBudgetedHost(database, 'initial-leg').finishToolActions();
    await expect(second.claimToolAction(next)).rejects.toThrow();
    await first.finishToolActions();
    await second.finishToolActions();
    await expect(second.claimToolAction(action)).rejects.toThrow();
    await expect(second.claimToolAction(next)).resolves.toBeUndefined();
    await second.finishToolActions();
    expect(
      (await database.query('SELECT state FROM brainstrike_delegated_tool_decisions')).rows
    ).toEqual([{ state: 'consumed' }, { state: 'consumed' }]);
  });

  it('shares one initial baseline across concurrent binds of the same invocation', async () => {
    const host = createBudgetedHost(database, 'initial-leg');
    await host.persist(identity);
    const [first, second] = await Promise.all([host.bindRun(run), host.bindRun(run)]);
    expect(first.baseline).toBeDefined();
    expect(second.baseline).toBe(first.baseline);
  });

  it('prepares history only for the admitted leaf and recaptures after an unexecuted release', async () => {
    const original = createBudgetedHost(database, 'initial-leg');
    await original.persist(identity);
    await original.bindRun(run);
    const host = createBudgetedHost(database, 'resume-leg');
    const action = {
      delegation: { path: [run], toolCallId: 'read-1' },
      runId: run.parentRuntimeRunId,
      toolCallId: run.parentToolCallId,
    };
    await expect(host.prepareToolAction(action)).rejects.toMatchObject({
      reason: 'history-requires-admission',
    });
    await host.claimToolAction(action);
    await expect(
      host.prepareToolAction({
        ...action,
        delegation: { ...action.delegation, toolCallId: 'different-leaf' },
      })
    ).rejects.toThrow();
    await host.prepareToolAction(action);
    expect((await host.bindRun(run)).baseline?.messages).toEqual([]);
    await host.releaseUnexecutedToolAction(action);
    await database.query(
      `INSERT INTO mastra_messages (id, thread_id, "resourceId", role, type, content, "createdAt")
       VALUES ('before-new-admission', 'child', 'native-child-owner', 'assistant', 'v2', $1, NOW())`,
      [JSON.stringify({ format: 2, parts: [{ text: 'Latest saved history', type: 'text' }] })]
    );
    await host.claimToolAction(action);
    await host.prepareToolAction(action);
    expect((await host.bindRun(run)).baseline?.messages).toMatchObject([
      { id: 'before-new-admission' },
    ]);
    await host.finishToolActions();
  });

  it('releases only its own unexecuted leaf claim and never a consumed decision', async () => {
    const owner = createBudgetedHost(database, 'initial-leg');
    const other = createBudgetedHost(database, 'resume-leg');
    await owner.persist(identity);
    await owner.bindRun(run);
    const action = {
      delegation: { path: [run], toolCallId: 'read-1' },
      runId: run.parentRuntimeRunId,
      toolCallId: run.parentToolCallId,
    };
    await owner.claimToolAction(action);
    await expect(
      createBudgetedHost(database, 'initial-leg').releaseUnexecutedToolAction(action)
    ).rejects.toMatchObject({ reason: 'tool-action-claim-lost' });
    await expect(other.releaseUnexecutedToolAction(action)).rejects.toMatchObject({
      reason: 'tool-action-claim-lost',
    });
    await expect(
      owner.releaseUnexecutedToolAction({
        ...action,
        delegation: { ...action.delegation, toolCallId: 'different-leaf' },
      })
    ).rejects.toMatchObject({ reason: 'tool-action-claim-lost' });
    await expect(other.claimToolAction(action)).rejects.toThrow();
    await owner.releaseUnexecutedToolAction(action);
    await owner.finishToolActions();
    await other.claimToolAction(action);
    await other.finishToolActions();
    await expect(other.releaseUnexecutedToolAction(action)).rejects.toMatchObject({
      reason: 'tool-action-claim-lost',
    });
    await expect(owner.claimToolAction(action)).rejects.toThrow();
    expect(
      (await database.query('SELECT state FROM brainstrike_delegated_tool_decisions')).rows
    ).toEqual([{ state: 'consumed' }]);
  });

  it('retains an interrupted decision after startup reaping without replaying its unknown effect', async () => {
    const original = createBudgetedHost(database, 'initial-leg');
    await original.persist(identity);
    await original.bindRun(run);
    const action = {
      delegation: { path: [run], toolCallId: 'read-1' },
      runId: run.parentRuntimeRunId,
      toolCallId: run.parentToolCallId,
    };
    await original.claimToolAction(action);
    const bootedAt = new Date();
    await database.query(
      "UPDATE brainstrike_assistant_thread_runs SET started_at = $1 WHERE id = 'initial-leg'",
      [new Date(bootedAt.getTime() - 120_000).toISOString()]
    );
    const reaped = await reapOrphanedThreadRuns(
      { query: (sql, params) => database.query(sql, params ? [...params] : undefined) },
      bootedAt
    );
    expect(reaped.reaped).toEqual([{ id: 'initial-leg', threadId: 'root' }]);
    expect(
      (await database.query('SELECT state FROM brainstrike_delegated_tool_decisions')).rows
    ).toEqual([{ state: 'interrupted' }]);
    const replacement = createBudgetedHost(database, 'resume-leg');
    await expect(replacement.claimToolAction(action)).rejects.toThrow();
    // No stale in-memory owner can overwrite the interrupted disposition.
    await expect(original.finishToolActions()).rejects.toMatchObject({
      reason: 'tool-action-claim-lost',
    });
    await expect(original.releaseUnexecutedToolAction(action)).rejects.toMatchObject({
      reason: 'tool-action-claim-lost',
    });
  });

  it('resolves tool action ancestry only for the owning root and original turn', async () => {
    const host = createBudgetedHost(database, 'initial-leg');
    await host.persist(identity);
    await host.bindRun(run);
    const action = {
      delegation: { path: [run], toolCallId: 'leaf-tool-call' },
      runId: run.parentRuntimeRunId,
      toolCallId: run.parentToolCallId,
    };
    expect(await createBudgetedHost(database, 'resume-leg').resolveToolAction(action)).toEqual([
      {
        configuration: identity.configuration,
        identity: run,
        resourceId: identity.childResourceId,
        threadId: identity.childThreadId,
      },
    ]);
    await expect(
      host.resolveToolAction({ runId: action.runId, toolCallId: action.toolCallId })
    ).rejects.toThrow();
    await expect(
      host.resolveToolAction({
        ...action,
        delegation: { ...action.delegation, path: [{ ...run, childRuntimeRunId: 'sibling-run' }] },
      })
    ).rejects.toThrow();
    for (const leg of ['other-turn-leg', 'other-root-leg']) {
      await expect(createBudgetedHost(database, leg).resolveToolAction(action)).rejects.toThrow();
    }
    expect(
      await host.resolveToolAction({ runId: action.runId, toolCallId: 'ordinary-call' })
    ).toEqual([]);
  });

  it('resolves a parked invocation from its dispatch address without a leaf identity', async () => {
    // The approval leg walks parked background siblings from the delegation
    // call they were dispatched by; no leaf identity exists yet, and
    // `resolveToolAction` refuses that bare address by design
    // (thread-22c3279b, 2026-09-14: the sibling grant died on it).
    const host = createBudgetedHost(database, 'initial-leg');
    await host.persist(identity);
    await host.bindRun(run);
    const address = {
      parentRuntimeRunId: run.parentRuntimeRunId,
      parentThreadId: identity.parentThreadId,
      parentToolCallId: run.parentToolCallId,
    };
    expect(await host.resolveParkedInvocation(address)).toEqual({
      identity: run,
      resourceId: identity.childResourceId,
      threadId: identity.childThreadId,
    });
    expect(
      await host.resolveParkedInvocation({ ...address, parentToolCallId: 'ordinary-call' })
    ).toBeUndefined();
    await expect(
      host.resolveParkedInvocation({ ...address, parentThreadId: 'elsewhere' })
    ).rejects.toMatchObject({ reason: 'suspended-invocation-ancestry-invalid' });
  });

  it('recovers only the bound invocation native message identity before resume publication', async () => {
    const host = createBudgetedHost(database, 'initial-leg');
    await host.persist(identity);
    expect(await host.bindRun(run)).toEqual({
      baseline: { hostRunId: 'initial-leg', messages: [], runEvents: [], threadId: 'child' },
      threadId: 'child',
    });
    await host.persistEvent(run, 'observed-before-pause', childStarted, 0);
    expect(await createBudgetedHost(database, 'resume-leg').bindRun(run)).toEqual({
      messageId: 'observed-before-pause',
      threadId: 'child',
    });
    await expect(createBudgetedHost(database, 'other-turn-leg').bindRun(run)).rejects.toThrow();
    await expect(
      host.bindRun({ ...run, childRuntimeRunId: 'different-native-run' })
    ).rejects.toThrow();
  });

  it('publishes the same sanitized metadata that reload reads', async () => {
    const host = createBudgetedHost(database, 'initial-leg');
    await host.persist(identity);
    await host.bindRun(run);
    const event = await host.persistEvent(
      run,
      'native-message',
      {
        ...childStarted,
        metadata: { nested: { authorization: 'private' }, prompt: 'private payload', safe: 'kept' },
      },
      0
    );
    const row = (
      await database.query<{ metadata: unknown }>(
        'SELECT metadata FROM brainstrike_assistant_run_events'
      )
    ).rows[0];
    expect(event.metadata).toEqual(row?.metadata);
    expect(event.metadata).toMatchObject({ nested: {}, safe: 'kept' });
    expect(event.metadata).not.toHaveProperty('prompt');
  });

  it.each(['other-turn-leg', 'other-root-leg', 'missing-leg'])(
    'rejects child events through unauthorized host %s without partial writes',
    async (leg) => {
      const host = createBudgetedHost(database, 'initial-leg');
      await host.persist(identity);
      await host.bindRun(run);
      await expect(
        createBudgetedHost(database, leg).persistEvent(run, 'native-message', childStarted, 0)
      ).rejects.toThrow();
      expect(
        (
          await database.query(
            "SELECT id FROM brainstrike_assistant_thread_runs WHERE thread_id = 'child'"
          )
        ).rows
      ).toEqual([]);
      expect(
        (await database.query('SELECT id FROM brainstrike_assistant_run_events')).rows
      ).toEqual([]);
    }
  );

  it('requires bound child/persona/message identities and preserves exact duplicate events', async () => {
    const host = createBudgetedHost(database, 'initial-leg');
    await host.persist(identity);
    await expect(host.persistEvent(run, 'native-message', childStarted, 0)).rejects.toThrow();
    await host.bindRun(run);
    await expect(
      host.persistEvent({ ...run, personaId: 'wrong' }, 'native-message', childStarted, 0)
    ).rejects.toThrow();
    await expect(
      host.persistEvent({ ...run, childRuntimeRunId: 'wrong' }, 'native-message', childStarted, 0)
    ).rejects.toThrow();
    await expect(host.persistEvent(run, '', childStarted, 0)).rejects.toThrow();
    const first = await host.persistEvent(run, 'native-message', childStarted, 0);
    expect(await host.persistEvent(run, 'native-message', childStarted, 0)).toEqual(first);
    const before = (await database.query('SELECT * FROM brainstrike_assistant_run_events')).rows;
    await expect(
      host.persistEvent(run, 'native-message', { ...childStarted, label: 'changed' }, 0)
    ).rejects.toThrow();
    expect((await database.query('SELECT * FROM brainstrike_assistant_run_events')).rows).toEqual(
      before
    );
  });

  it.each([
    { accepted: true, model: { modelId: 'pinned', provider: 'anthropic' } },
    { accepted: false, model: null },
    { accepted: false, model: { modelId: 'pinned', provider: '' } },
  ])(
    'records the actual pinned child model or rejects malformed pins: $model',
    async ({ model, accepted }) => {
      const host = createBudgetedHost(database, 'initial-leg');
      await host.persist({
        ...identity,
        configuration: { maxSteps: 16, persona: { id: 'explore', model } },
      });
      await host.bindRun(run);
      const write = host.persistEvent(run, 'native-message', childStarted, 0);
      if (!accepted) {
        await expect(write).rejects.toThrow();
        expect(
          (
            await database.query(
              "SELECT id FROM brainstrike_assistant_thread_runs WHERE thread_id = 'child'"
            )
          ).rows
        ).toEqual([]);
        return;
      }
      await write;
      expect(
        (
          await database.query(
            "SELECT provider, model, model_settings, provider_options FROM brainstrike_assistant_thread_runs WHERE thread_id = 'child'"
          )
        ).rows
      ).toEqual([
        { model: 'pinned', model_settings: null, provider: 'anthropic', provider_options: null },
      ]);
    }
  );

  it('preserves nested invocation metadata inside a child transcript instead of replacing it with the owning edge', async () => {
    const host = createBudgetedHost(database, 'initial-leg');
    await host.persist(identity);
    await host.bindRun(run);
    const event = await host.persistEvent(
      run,
      'native-child-message',
      {
        id: 'nested-start',
        kind: 'subagent.started',
        label: 'Nested worker',
        metadata: {
          parentRuntimeRunId: run.childRuntimeRunId,
          parentToolCallId: 'grandchild-call',
          personaId: 'worker',
        },
        status: 'running',
        timestamp: new Date().toISOString(),
      },
      0
    );
    expect(event.metadata).toMatchObject({
      delegatedConversationIdentity: run,
      parentRuntimeRunId: run.childRuntimeRunId,
      parentToolCallId: 'grandchild-call',
      personaId: 'worker',
    });
    const saved = await database.query(
      "SELECT metadata FROM brainstrike_assistant_run_events WHERE id = 'nested-start'"
    );
    expect(saved.rows).toEqual([{ metadata: event.metadata }]);
  });

  it('persists child lifecycle in ordinary child run/event records while keeping the root running', async () => {
    const host = createBudgetedHost(database, 'initial-leg');
    await host.persist(identity);
    await host.bindRun(run);
    const timestamp = new Date().toISOString();
    async function* source(): AsyncIterable<StreamChunk> {
      for (const [id, kind, status] of [
        ['child-start', 'run.started', 'running'],
        ['child-finish', 'run.finished', 'completed'],
      ] as const) {
        yield {
          chunk: { event: { id, kind, label: kind, status, timestamp }, type: 'run-event' },
          identity: run,
          messageId: 'native-child-message',
          type: 'delegated-conversation-chunk',
        };
      }
    }
    const output: StreamChunk[] = [];
    for await (const chunk of observeDesktopAssistantRunEvents(
      source(),
      'initial-leg',
      [],
      async () => database
    )) {
      output.push(chunk);
    }
    const records = (
      await database.query<{
        id: string;
      }>(`SELECT runs.id, runs.thread_id, runs.resource_id, runs.provider, runs.model, runs.status,
      runs.turn_message_id, event.id AS event_id, event.run_id, event.sequence, event.metadata
      FROM brainstrike_assistant_thread_runs runs JOIN brainstrike_assistant_run_events event ON event.run_id = runs.id
      WHERE runs.thread_id = 'child' ORDER BY event.sequence`)
    ).rows;
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      event_id: 'child-start',
      metadata: { childRuntimeRunId: 'child-native-run', nativeMessageId: 'native-child-message' },
      model: 'test',
      provider: 'openai',
      resource_id: 'native-child-owner',
      sequence: 0,
      status: 'completed',
      thread_id: 'child',
      turn_message_id: null,
    });
    expect(records[1]).toMatchObject({ event_id: 'child-finish', sequence: 1 });
    expect(records[0]?.['id']).not.toBe('initial-leg');
    expect(
      (
        await database.query(
          "SELECT status FROM brainstrike_assistant_thread_runs WHERE id = 'initial-leg'"
        )
      ).rows
    ).toEqual([{ status: 'running' }]);
    expect(output[0]).toMatchObject({
      chunk: { event: { runId: records[0]?.['id'], sequence: 0 } },
      type: 'delegated-conversation-chunk',
    });
  });

  it('uses the existing usage writer for one cumulative row across host resume legs', async () => {
    const host = createBudgetedHost(database, 'initial-leg');
    await host.persist(identity);
    await host.bindRun(run);
    await persistUsage(usage);
    await persistUsage(usage);
    await persistUsage({ ...usage, inputTokens: 10, outputTokens: 6 }, 'resume-leg');
    expect(
      (
        await database.query(`SELECT run_id, input_tokens, output_tokens, delegation_tool_call_id
      FROM brainstrike_assistant_run_usage`)
      ).rows
    ).toEqual([
      {
        delegation_tool_call_id: 'parent-call',
        input_tokens: 10,
        output_tokens: 6,
        run_id: 'initial-leg',
      },
    ]);
  });

  it('hydrates both host resume legs onto their observed native assistant message', async () => {
    const host = createBudgetedHost(database, 'initial-leg');
    await host.persist(identity);
    await host.bindRun(run);
    await database.query(
      `INSERT INTO mastra_messages (id, thread_id, "resourceId", role, type, content, "createdAt")
      VALUES ('native-child-message', 'child', 'native-child-owner', 'assistant', 'v2', $1, $2)`,
      [
        JSON.stringify({ format: 2, parts: [{ text: 'Full child answer', type: 'text' }] }),
        '2026-09-10T01:00:00Z',
      ]
    );
    const first = await host.persistEvent(
      run,
      'native-child-message',
      {
        id: 'before-pause',
        kind: 'tool.approval.requested',
        label: 'Approval',
        status: 'info',
        timestamp: '2026-09-10T01:00:01.000Z',
      },
      0
    );
    const middle = await host.persistEvent(
      run,
      'native-child-message',
      {
        id: 'pause-visible',
        kind: 'tool.approval.requested',
        label: 'Waiting for approval',
        status: 'info',
        timestamp: '2026-09-10T01:00:02.000Z',
      },
      1
    );
    const second = await createBudgetedHost(database, 'resume-leg').persistEvent(
      run,
      'native-child-message',
      {
        id: 'after-resume',
        kind: 'run.finished',
        label: 'Complete',
        status: 'completed',
        timestamp: '2026-09-10T01:00:03.000Z',
      },
      0
    );
    expect(first.runId).not.toBe(second.runId);
    const history = await createAssistantThreadHistoryAdapter({
      repository: createPgliteAssistantThreadRepository(database as unknown as DbHandle),
      resourceId: 'native-child-owner',
      threadId: 'child',
    }).load();
    const parts = history.messages.flatMap(({ message }) =>
      message.role === 'assistant' ? message.content : []
    );
    expect(
      parts.filter((part) => part.type === 'data' && part.name === 'brainstrike.run-event')
    ).toEqual([
      { data: first, name: 'brainstrike.run-event', type: 'data' },
      { data: middle, name: 'brainstrike.run-event', type: 'data' },
      { data: second, name: 'brainstrike.run-event', type: 'data' },
    ]);
  });

  it('rejects missing or unauthorized bound usage before publishing a refresh chunk', async () => {
    const { delegation: _delegation, ...withoutIdentity } = usage;
    await expect(persistUsage(withoutIdentity)).rejects.toThrow();
    await expect(persistUsage(usage)).rejects.toThrow();
    const host = createBudgetedHost(database, 'initial-leg');
    await host.persist(identity);
    await expect(persistUsage(usage)).rejects.toThrow();
    await host.bindRun(run);
    await expect(persistUsage(usage, 'other-turn-leg')).rejects.toThrow();
    await expect(persistUsage({ ...usage, personaId: 'wrong' })).rejects.toThrow();
    expect((await database.query('SELECT id FROM brainstrike_assistant_run_usage')).rows).toEqual(
      []
    );
  });

  it('logs and propagates a storage failure without publishing a usage refresh', async () => {
    const error = new Error('Database unavailable');
    const diagnostic = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    async function* source(): AsyncIterable<StreamChunk> {
      yield { type: 'child-run-usage', value: usage };
    }
    const iterator = persistDesktopChildRunUsage(
      source(),
      'initial-leg',
      undefined,
      () => Promise.reject(error),
      true
    )[Symbol.asyncIterator]();
    try {
      await expect(iterator.next()).rejects.toBe(error);
      expect(diagnostic).toHaveBeenCalledWith(
        'Failed to persist bound delegated usage',
        expect.objectContaining({
          code: 'assistant_delegated_usage_write_failed',
          error,
          runId: 'initial-leg',
        })
      );
    } finally {
      diagnostic.mockRestore();
    }
  });

  it('persists native child identity and a stable display before binding its run', async () => {
    const host = createBudgetedHost(database, 'initial-leg');
    await host.persist(identity);
    const repository = createDelegatedConversationRepository(database);
    const child = await repository.get(scope, 'child');
    expect(child).toMatchObject({
      ...scope,
      parentThreadId: 'root',
      resourceId: 'native-child-owner',
    });
    expect(child?.displayName).toMatch(/^[A-Z][a-z]+-[0-9a-f]{6}$/u);
    expect(await repository.getInvocation(scope, run)).toMatchObject({
      childRuntimeRunId: null,
      hostRunId: 'initial-leg',
      turnMessageId: 'user-turn',
    });
    await host.bindRun(run);
    await host.persist(identity);
    expect(await repository.get(scope, 'child')).toEqual(child);
    expect(await repository.getInvocation(scope, run)).toMatchObject({
      childRuntimeRunId: 'child-native-run',
    });
  });

  it('reauthorizes the original invocation across reconstructed host resume legs', async () => {
    const host = createBudgetedHost(database, 'initial-leg');
    await host.persist(identity);
    await host.bindRun(run);
    await createBudgetedHost(database, 'resume-leg').bindRun(run);
    expect(
      await createDelegatedConversationRepository(database).getInvocation(scope, run)
    ).toMatchObject({ childRuntimeRunId: 'child-native-run', hostRunId: 'initial-leg' });
  });

  it.each(['other-turn-leg', 'other-root-leg', 'missing-leg'])(
    'rejects resumed publication through an unauthorized host leg (%s)',
    async (runId) => {
      await createBudgetedHost(database, 'initial-leg').persist(identity);
      await expect(createBudgetedHost(database, runId).bindRun(run)).rejects.toThrow();
      expect(
        await createDelegatedConversationRepository(database).getInvocation(scope, run)
      ).toMatchObject({ childRuntimeRunId: null });
    }
  );

  it('rechecks the current host turn atomically when it changes after scope lookup', async () => {
    const initial = createBudgetedHost(database, 'initial-leg');
    await initial.persist(identity);
    const raced = createDesktopDelegatedConversationHost(
      {
        query: async (sql, params) => {
          const result = await database.query(sql, params);
          if (sql.includes('WHERE runs.id = $1')) {
            await database.exec(
              "UPDATE brainstrike_assistant_thread_runs SET turn_message_id = 'changed' WHERE id = 'resume-leg'"
            );
          }
          return result;
        },
      },
      'resume-leg'
    );
    await expect(raced.bindRun(run)).rejects.toThrow();
    expect(
      await createDelegatedConversationRepository(database).getInvocation(scope, run)
    ).toMatchObject({ childRuntimeRunId: null });
  });

  it('rejects a forged parent native resource before registering its child', async () => {
    await expect(
      createBudgetedHost(database, 'initial-leg').persist({
        ...identity,
        parentResourceId: 'forged',
      })
    ).rejects.toThrow();
    expect((await database.query('SELECT * FROM brainstrike_delegated_invocations')).rows).toEqual(
      []
    );
  });

  it('rejects an observed persona mismatch and changed native scope', async () => {
    const host = createBudgetedHost(database, 'initial-leg');
    await host.persist(identity);
    await expect(host.bindRun({ ...run, personaId: 'analyze' })).rejects.toThrow();
    await database.query(`UPDATE mastra_threads SET "resourceId" = 'changed' WHERE id = 'child'`);
    await expect(host.bindRun(run)).rejects.toThrow();
  });

  it('persists concurrent instances of the same persona independently', async () => {
    const host = createBudgetedHost(database, 'initial-leg');
    await Promise.all([
      host.persist(identity),
      host.persist({
        ...identity,
        childResourceId: 'native-sibling-owner',
        childThreadId: 'sibling',
        parentToolCallId: 'sibling-call',
      }),
    ]);
    const children = await createDelegatedConversationRepository(database).listChildren(
      scope,
      'root'
    );
    expect(children.map((child) => child.threadId).sort()).toEqual(['child', 'sibling']);
    expect(new Set(children.map((child) => child.displayName)).size).toBe(2);
    for (const child of children) {
      expect(child.configuration).toEqual(identity.configuration);
      expect(child.displayName).toMatch(/^[A-Z][a-z]+-[0-9a-f]{6}$/u);
      expect(child.color).toBeTruthy();
    }
    // New host/repository instances must restore the same persisted identities,
    // not issue a new callsign or derive the UI label from the shared persona.
    const restoredHost = createBudgetedHost(database, 'initial-leg');
    await restoredHost.persist(identity);
    await restoredHost.persist({
      ...identity,
      childResourceId: 'native-sibling-owner',
      childThreadId: 'sibling',
      parentToolCallId: 'sibling-call',
    });
    expect(
      await createDelegatedConversationRepository(database).listChildren(scope, 'root')
    ).toEqual(children);
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
});
