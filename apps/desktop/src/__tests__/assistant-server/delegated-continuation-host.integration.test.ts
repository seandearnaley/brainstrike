// @vitest-environment node
import { createTool } from '@brainstrike/agent/test-fixtures/delegated-stream';
import {
  scriptedAgentModel,
  textParts,
  toolCallParts,
} from '@brainstrike/agent/test-fixtures/scripted-agent-model';
import { buildNativeToolRiskMap } from '@brainstrike/assistant-contract';
import { DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS } from '@brainstrike/assistant-contract/memory-settings';
import { createPgliteAssistantThreadRepository } from '@brainstrike/assistant-data';
import { createDelegatedConversationRepository, migrate, wasmLoader } from '@brainstrike/db';
import type { DbHandle } from '@brainstrike/db/react';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { cancelDelegatedContinuations } from '../../assistant-server/delegated-continuation-cancellation';
import { createDesktopDelegatedContinuationHost } from '../../assistant-server/delegated-continuation-host';
import { createDesktopDelegatedConversationHost } from '../../assistant-server/delegated-conversation-host';
import { readDelegatedDecisionStates } from '../../assistant-server/delegated-decision-discovery';
import {
  getDesktopMastraMemory,
  resetDesktopMastraMemoryCacheForTests,
} from '../../assistant-server/mastra-memory';
import { handleSuspendedRunsRequest } from '../../assistant-server/status-endpoints';
import { reapOrphanedThreadRuns } from '../../assistant-server/thread-run-startup-reaper';
import { createRunRequest } from './_harness';

const runDiscoveryRequest = createRunRequest((req, res, options = {}) =>
  handleSuspendedRunsRequest(req, res, options)
);
const cancel = vi.hoisted(() => vi.fn<(id: string) => Promise<void>>(async () => {}));
vi.mock('@brainstrike/assistant-service/steering', () => ({ cancelSteerableRunAndWait: cancel }));
const databaseHolder = vi.hoisted(() => ({ current: undefined as PGlite | undefined }));
vi.mock('../../db-main', () => ({
  getDatabase: async () => {
    if (!databaseHolder.current) {
      throw new Error('Fixture database is unavailable.');
    }
    return databaseHolder.current;
  },
}));
vi.mock('@brainstrike/agent', async (original) => ({
  ...(await original<typeof import('@brainstrike/agent')>()),
}));
const {
  streamMastraChildFollowup,
  streamMastraToolApprovalAction,
  createStatelessAssistantDataStreamResponse,
} = await import('@brainstrike/agent');
let database: PGlite;
const scope = { ownerResourceId: 'owner', rootThreadId: 'root' };
const input = { id: 'new-human-input', text: 'Continue the work.', threadId: 'child' };
const configuration = {
  maxSteps: 8,
  persona: { id: 'worker', instructions: 'Exact original profile' },
};
const port = () => createDesktopDelegatedConversationHost(database, 'wake-host').continuation;
beforeEach(async () => {
  resetDesktopMastraMemoryCacheForTests();
  cancel.mockResolvedValue(undefined);
  database = await wasmLoader.createPGlite('memory://continuation-host');
  databaseHolder.current = database;
  await migrate(database);
  await database.exec(`INSERT INTO mastra_threads (id,"resourceId",title,metadata,"createdAt","updatedAt") VALUES
    ('root','owner','Root','{}',NOW(),NOW()),('child','child-resource','Child','{}',NOW(),NOW()),('sibling','sibling-resource','Sibling','{}',NOW(),NOW());
    INSERT INTO brainstrike_assistant_thread_runs(id,resource_id,thread_id,provider,model,runtime_kind,status,started_at,created_at,updated_at,turn_message_id)
    VALUES ('wake-host','owner','root','openai','test','desktop','running',NOW(),NOW(),NOW(),'new-root-user');`);
  const graph = createDelegatedConversationRepository(database);
  await graph.registerRoot(scope);
  for (const threadId of ['child', 'sibling']) {
    await graph.createChild(scope, {
      color: 'blue',
      configuration,
      displayName: threadId,
      parentThreadId: 'root',
      resourceId: `${threadId}-resource`,
      threadId,
    });
  }
});
afterEach(async () => {
  await database.close();
  databaseHolder.current = undefined;
});

it('settles a committed receipt when history capture fails and admits a new explicit input', async () => {
  const failure = new Error('Actual history read failed');
  const host = createDesktopDelegatedContinuationHost(
    database,
    'wake-host',
    async () => ({ ...scope, turnMessageId: 'new-root-user' }),
    async () => {
      throw failure;
    }
  );
  await expect(host.prepareContinuation(input)).rejects.toBe(failure);
  expect(
    await createDelegatedConversationRepository(database).getContinuation(scope, input.id)
  ).toMatchObject({ nativeRunId: null, state: 'failed' });
  await expect(port().prepareContinuation(input)).rejects.toMatchObject({
    reason: 'continuation-input-already-admitted',
  });
  await expect(
    port().prepareContinuation({ ...input, id: 'explicit-after-history-error' })
  ).resolves.toMatchObject({ id: 'explicit-after-history-error' });
});

it('preserves both history and failed-settlement errors after committed admission', async () => {
  const historyFailure = new Error('History read failed');
  const settlementFailure = new Error('Receipt write failed');
  const transaction = vi.spyOn(database, 'transaction');
  const host = createDesktopDelegatedContinuationHost(
    database,
    'wake-host',
    async () => ({ ...scope, turnMessageId: 'new-root-user' }),
    async () => {
      transaction.mockRejectedValueOnce(settlementFailure);
      throw historyFailure;
    }
  );
  try {
    await expect(host.prepareContinuation(input)).rejects.toMatchObject({
      errors: [historyFailure, settlementFailure],
      message: 'Child history capture and receipt settlement failed.',
    });
  } finally {
    transaction.mockRestore();
  }
});

it('cleanup after an unexecuted decision release leaves its pending receipt actionable', async () => {
  const host = port();
  await host.prepareContinuation(input);
  await host.bindContinuation({ id: input.id, nativeRunId: 'native-wake' });
  await host.finishContinuation({ id: input.id, status: 'awaiting-approval' });
  const decision = {
    id: input.id,
    kind: 'tool-approval' as const,
    nativeRunId: 'native-wake',
    toolCallId: 'leaf',
  };
  await host.resolveContinuationDecision(decision);
  await host.claimContinuationDecision(decision);
  await host.finishContinuationDecision({ ...decision, toolCallId: 'unowned-leaf' });
  expect(
    (await database.query('SELECT state FROM brainstrike_delegated_continuation_decisions')).rows
  ).toEqual([{ state: 'claimed' }]);
  await host.releaseUnexecutedContinuationDecision(decision);
  await expect(host.finishContinuationDecision(decision)).resolves.toBeUndefined();
  expect(await host.resolveContinuationDecision(decision)).toMatchObject({
    state: 'awaiting-approval',
  });
  expect(
    (await database.query('SELECT * FROM brainstrike_delegated_continuation_decisions')).rows
  ).toEqual([]);
});

it('admits through the real host and reserves the existing durable child/tree budgets before native wake', async () => {
  const host = port();
  expect(await host.prepareContinuation(input)).toMatchObject({
    configuration,
    depth: 1,
    resourceId: 'child-resource',
    threadId: 'child',
  });
  const bound = await host.bindContinuation({ id: input.id, nativeRunId: 'native-wake' });
  expect(bound).toMatchObject({
    baseline: { hostRunId: 'wake-host', messages: [], runEvents: [], threadId: 'child' },
    threadId: 'child',
  });
  expect(bound.messageId).not.toBe('native-wake');
  expect(
    (await database.query('SELECT invocations FROM brainstrike_delegation_budgets')).rows
  ).toEqual([{ invocations: 1 }]);
  expect(
    (
      await database.query(
        'SELECT child_thread_id,max_steps FROM brainstrike_delegation_child_budgets'
      )
    ).rows
  ).toEqual([{ child_thread_id: 'child', max_steps: 8 }]);
  expect(
    (await database.query('SELECT * FROM brainstrike_delegated_invocations')).rows
  ).toHaveLength(0);
});
it('resumes an exact decision against the original durable child budget instead of resetting its steps', async () => {
  const first = createDesktopDelegatedConversationHost(database, 'wake-host');
  await first.continuation.prepareContinuation(input);
  await first.continuation.bindContinuation({ id: input.id, nativeRunId: 'native-wake' });
  const child = { resourceId: 'child-resource', threadId: 'child' };
  const step = await first.budget.reserveStep(child);
  await first.budget.settleStep(step.id, 3);
  await first.continuation.finishContinuation({ id: input.id, status: 'awaiting-approval' });
  await database.exec(`UPDATE brainstrike_assistant_thread_runs SET status='completed' WHERE id='wake-host';
    INSERT INTO brainstrike_assistant_thread_runs(id,resource_id,thread_id,provider,model,runtime_kind,status,started_at,created_at,updated_at,turn_message_id)
    VALUES ('resume-host','owner','root','openai','test','desktop','running',NOW(),NOW(),NOW(),'new-root-user');`);
  const resumed = createDesktopDelegatedConversationHost(database, 'resume-host');
  const decision = {
    id: input.id,
    kind: 'tool-approval' as const,
    nativeRunId: 'native-wake',
    toolCallId: 'approval',
  };
  await resumed.continuation.resolveContinuationDecision(decision);
  await resumed.continuation.claimContinuationDecision(decision);
  await resumed.continuation.bindContinuation({ id: input.id, nativeRunId: 'native-wake' });
  const next = await resumed.budget.reserveStep(child);
  await resumed.budget.settleStep(next.id, 2);
  expect(
    (await database.query('SELECT turn_message_id,steps FROM brainstrike_delegation_child_budgets'))
      .rows
  ).toEqual([{ steps: 2, turn_message_id: 'new-root-user' }]);
  expect(
    (await database.query('SELECT invocations FROM brainstrike_delegation_budgets')).rows
  ).toEqual([{ invocations: 1 }]);
  await resumed.continuation.finishContinuationDecision(decision);
  await resumed.continuation.finishContinuation({ id: input.id, status: 'completed' });
});
it('authorizes continuation descendants through their saved parent and consumes sibling leaf calls independently', async () => {
  const host = createDesktopDelegatedConversationHost(database, 'wake-host');
  await host.continuation.prepareContinuation(input);
  await host.continuation.bindContinuation({ id: input.id, nativeRunId: 'native-wake' });
  const graph = createDelegatedConversationRepository(database);
  const decisions = [];
  for (const suffix of ['a', 'b']) {
    const threadId = `descendant-${suffix}`;
    const resourceId = `resource-${suffix}`;
    await database.query(
      'INSERT INTO mastra_threads(id,"resourceId",title,metadata,"createdAt","updatedAt") VALUES ($1,$2,$1,$3::jsonb,NOW(),NOW())',
      [threadId, resourceId, '{}']
    );
    await graph.createChild(scope, {
      color: 'blue',
      configuration,
      displayName: threadId,
      parentThreadId: 'child',
      resourceId,
      threadId,
    });
    const edge = {
      childRuntimeRunId: `leaf-native-${suffix}`,
      parentRuntimeRunId: 'native-wake',
      parentToolCallId: `delegate-${suffix}`,
      personaId: 'worker',
    };
    await graph.createInvocation(scope, {
      ...edge,
      hostRunId: 'wake-host',
      parentThreadId: 'child',
      threadId,
    });
    await graph.bindInvocationRun(scope, edge, edge.childRuntimeRunId, 'wake-host');
    decisions.push({
      delegation: { path: [edge], toolCallId: 'same-leaf-call' },
      id: input.id,
      kind: 'tool-approval' as const,
      nativeRunId: 'native-wake',
      toolCallId: edge.parentToolCallId,
    });
  }
  await host.continuation.finishContinuation({ id: input.id, status: 'awaiting-approval' });
  for (const decision of decisions) {
    const action = {
      continuationId: input.id,
      delegation: decision.delegation,
      runId: decision.nativeRunId,
      toolCallId: decision.toolCallId,
    };
    const { continuationId: _continuationId, ...unanchored } = action;
    await expect(host.resolveToolAction(unanchored)).rejects.toThrow();
    await expect(
      host.resolveToolAction({ ...action, continuationId: 'foreign-receipt' })
    ).rejects.toThrow();
    await expect(host.prepareToolAction(action)).rejects.toThrow();
    await host.continuation.resolveContinuationDecision(decision);
    await host.continuation.claimContinuationDecision(decision);
    await host.prepareToolAction(action);
    await host.continuation.finishContinuationDecision(decision);
    await host.continuation.finishContinuation({ id: input.id, status: 'awaiting-approval' });
    await expect(host.continuation.claimContinuationDecision(decision)).rejects.toThrow();
  }
  expect(
    (
      await database.query(
        'SELECT target_runtime_run_id, tool_call_id, state FROM brainstrike_delegated_continuation_decisions ORDER BY target_runtime_run_id'
      )
    ).rows
  ).toEqual([
    { state: 'consumed', target_runtime_run_id: 'leaf-native-a', tool_call_id: 'same-leaf-call' },
    { state: 'consumed', target_runtime_run_id: 'leaf-native-b', tool_call_id: 'same-leaf-call' },
  ]);
  expect((await database.query('SELECT * FROM brainstrike_delegated_tool_decisions')).rows).toEqual(
    []
  );
  await database.query(
    "UPDATE brainstrike_delegated_invocations SET cancellation_requested_at=NOW() WHERE thread_id='descendant-b'"
  );
  const stopped = decisions.at(-1);
  if (!stopped) {
    throw new Error('Missing descendant decision');
  }
  await expect(
    host.continuation.resolveContinuationDecision({
      ...stopped,
      delegation: { ...stopped.delegation, toolCallId: 'new-call-after-stop' },
    })
  ).rejects.toThrow();
});

it('rolls back receipt admission with the budget failure rather than leave an execution claim', async () => {
  const host = port();
  await host.prepareContinuation(input);
  await host.finishContinuation({ error: 'Never launched', id: input.id, status: 'failed' });
  await database.query('UPDATE brainstrike_delegation_budgets SET invocations=max_invocations');
  await expect(port().prepareContinuation({ ...input, id: 'over-budget' })).rejects.toThrow(
    'invocation limit'
  );
  expect(
    (
      await database.query(
        "SELECT * FROM brainstrike_delegated_continuations WHERE id='over-budget'"
      )
    ).rows
  ).toHaveLength(0);
});
it('persists the same rich-event identity emitted for the child and refuses a foreign display message', async () => {
  const host = port();
  await host.prepareContinuation(input);
  const binding = await host.bindContinuation({ id: input.id, nativeRunId: 'native-wake' });
  const event = {
    id: 'native-start',
    kind: 'run.started',
    label: 'Working',
    status: 'running',
    timestamp: new Date().toISOString(),
  } as const;
  await expect(
    host.persistContinuationEvent({
      event,
      id: input.id,
      messageId: 'foreign-message',
      sequence: 0,
    })
  ).rejects.toThrow();
  await host.persistContinuationEvent({
    event,
    id: input.id,
    messageId: binding.messageId,
    sequence: 0,
  });
  expect(
    (await database.query('SELECT metadata FROM brainstrike_assistant_run_events')).rows
  ).toEqual([
    {
      metadata: {
        continuationHostRunId: 'wake-host',
        continuationId: input.id,
        continuationNativeRunId: 'native-wake',
        nativeMessageId: binding.messageId,
      },
    },
  ]);
});
it('retains a dead execution receipt as interrupted without re-admitting its input', async () => {
  const host = port();
  await host.prepareContinuation(input);
  await reapOrphanedThreadRuns(database, new Date(Date.now() + 60_000));
  expect(
    (await database.query('SELECT state FROM brainstrike_delegated_continuations')).rows
  ).toEqual([{ state: 'interrupted' }]);
  await expect(port().prepareContinuation(input)).rejects.toThrow();
});
it('fences selected continuation admission before joining its actual managed owner and leaves sibling data intact', async () => {
  const host = port();
  await host.prepareContinuation(input);
  let release: () => void = () => {};
  cancel.mockImplementationOnce(async (hostRunId) => {
    expect(hostRunId).toBe('wake-host');
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  const stopping = cancelDelegatedContinuations(database, scope, 'child', false);
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith('wake-host'));
  await expect(host.bindContinuation({ id: input.id, nativeRunId: 'late-wake' })).rejects.toThrow();
  release();
  await stopping;
  expect(
    (await database.query('SELECT state FROM brainstrike_delegated_continuations')).rows
  ).toEqual([{ state: 'cancelled' }]);
  expect(
    (await database.query("SELECT id FROM mastra_threads WHERE id='sibling'")).rows
  ).toHaveLength(1);
});
it('does not acknowledge Stop when the managed native owner fails its join', async () => {
  const host = port();
  await host.prepareContinuation(input);
  cancel.mockRejectedValueOnce(new Error('Native join failed'));
  await expect(cancelDelegatedContinuations(database, scope, 'child', false)).rejects.toThrow(
    'Native join failed'
  );
  expect(
    (
      await database.query(
        'SELECT state,cancellation_requested_at IS NOT NULL AS fenced FROM brainstrike_delegated_continuations'
      )
    ).rows
  ).toEqual([{ fenced: true, state: 'claimed' }]);
});

it('cancels an idle suspended continuation with a durable terminal event and no native restart', async () => {
  const host = port();
  await host.prepareContinuation(input);
  const bound = await host.bindContinuation({ id: input.id, nativeRunId: 'native-wake' });
  await host.persistContinuationEvent({
    event: {
      id: 'pause',
      kind: 'tool.approval.requested',
      label: 'Needs approval',
      metadata: { toolCallId: 'leaf-call' },
      status: 'running',
      timestamp: new Date().toISOString(),
    },
    id: input.id,
    messageId: bound.messageId,
    sequence: 0,
  });
  await host.finishContinuation({ id: input.id, status: 'awaiting-approval' });
  const decision = {
    id: input.id,
    kind: 'tool-approval' as const,
    nativeRunId: 'native-wake',
    toolCallId: 'leaf-call',
  };
  await host.resolveContinuationDecision(decision);
  await host.claimContinuationDecision(decision);
  await host.releaseUnexecutedContinuationDecision(decision);
  expect(
    (
      await database.query(
        "SELECT status FROM brainstrike_assistant_thread_runs WHERE thread_id='child'"
      )
    ).rows
  ).toEqual([{ status: 'awaiting-approval' }]);
  await cancelDelegatedContinuations(database, scope, 'child', false);
  expect(
    (await database.query('SELECT kind FROM brainstrike_assistant_run_events ORDER BY sequence'))
      .rows
  ).toEqual([{ kind: 'tool.approval.requested' }, { kind: 'run.cancelled' }]);
  expect(
    (
      await database.query(
        "SELECT metadata FROM brainstrike_assistant_run_events WHERE kind='run.cancelled'"
      )
    ).rows
  ).toEqual([
    {
      metadata: {
        continuationHostRunId: 'wake-host',
        continuationId: input.id,
        continuationNativeRunId: 'native-wake',
        nativeMessageId: bound.messageId,
      },
    },
  ]);
  expect(
    (
      await database.query(
        "SELECT status FROM brainstrike_assistant_thread_runs WHERE thread_id='child'"
      )
    ).rows
  ).toEqual([{ status: 'cancelled' }]);
  await expect(
    host.prepareContinuation({ ...input, id: 'explicit-new-input' })
  ).resolves.toMatchObject({ id: 'explicit-new-input' });
});

it.each(['complete', 'approval'] as const)(
  'uses the real desktop memory factory to wake and reload the same child through public native streaming (%s)',
  async (mode) => {
    const persona = {
      allowedToolIds: ['brainstrike.grepSearch'],
      description: 'Read evidence',
      id: 'worker',
      instructions: 'Use the saved child context.',
      label: 'Worker',
      maxSteps: 8,
    };
    await database.query(
      'UPDATE brainstrike_delegated_conversations SET configuration=$1::jsonb WHERE thread_id=$2',
      [JSON.stringify({ maxSteps: 8, persona }), 'child']
    );
    await database.exec(`INSERT INTO brainstrike_assistant_thread_runs(id,resource_id,thread_id,provider,model,runtime_kind,status,started_at,created_at,updated_at,turn_message_id)
    VALUES ('original-host','owner','root','openai','test','desktop','completed',NOW(),NOW(),NOW(),'original-user');`);
    const graph = createDelegatedConversationRepository(database);
    await graph.createInvocation(scope, {
      hostRunId: 'original-host',
      parentRuntimeRunId: 'original-parent-native',
      parentThreadId: 'root',
      parentToolCallId: 'original-delegate',
      personaId: 'worker',
      threadId: 'child',
    });
    await graph.bindInvocationRun(
      scope,
      {
        parentRuntimeRunId: 'original-parent-native',
        parentToolCallId: 'original-delegate',
        personaId: 'worker',
      },
      'original-child-native',
      'original-host'
    );
    const original = await database.query('SELECT * FROM brainstrike_delegated_invocations');
    const runtime = {
      apiKey: 'test-key',
      assistantMessageId: 'parent-outcome-message',
      memory: { resourceId: 'owner', threadId: 'root' },
      model: 'gpt-5.4',
      provider: 'openai' as const,
    };
    const backing = await getDesktopMastraMemory(
      {
        ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
        observationalMemory: {
          ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.observationalMemory,
          enabled: false,
        },
      },
      'wake-host',
      undefined,
      runtime
    );
    if (!(backing.memory && backing.storage)) {
      throw new Error('Missing production native backing');
    }
    await backing.memory.saveMessages({
      messages: [
        {
          content: { format: 2, parts: [{ text: 'PRIOR_SAVED_CHILD_HISTORY', type: 'text' }] },
          createdAt: new Date('2026-09-12T00:00:00Z'),
          id: 'prior-child-message',
          resourceId: 'child-resource',
          role: 'assistant',
          threadId: 'child',
          type: 'text',
        },
      ],
    });

    let modelCalls = 0;
    const effect = vi.fn(async () => ({ matches: ['ACTUAL_EFFECT'] }));
    const model = scriptedAgentModel(() => {
      modelCalls += 1;
      return mode === 'approval' && modelCalls === 1
        ? toolCallParts('brainstrike_grepSearch', 'real-leaf', { pattern: 'proof' })
        : textParts('REAL_CHILD_CONTINUATION');
    });
    const options = {
      ...backing,
      getDelegatedSystemContext: () => [],
      modelOverride: model.model,
      personas: [],
      runtime: {
        ...runtime,
        permissionPolicy: {
          policies: {
            edit: 'deny' as const,
            execute: 'deny' as const,
            mcp: 'deny' as const,
            read: mode === 'approval' ? ('ask' as const) : ('allow' as const),
          },
          riskByTool: buildNativeToolRiskMap(),
          yolo: false,
        },
      },
      tools: {
        'brainstrike.grepSearch': createTool({
          description: 'Read evidence',
          execute: effect,
          id: 'brainstrike.grepSearch',
          inputSchema: z.object({ pattern: z.string() }),
        }),
      },
    };
    const stream = await streamMastraChildFollowup(input, options);
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    expect(chunks.some((chunk) => chunk.type === 'child-continuation-chunk')).toBe(true);
    const response = createStatelessAssistantDataStreamResponse(
      (async function* () {
        yield* chunks;
      })(),
      { messageId: 'parent-outcome-message' }
    );
    const wire = await response.text();
    expect(wire).toContain('PRIOR_SAVED_CHILD_HISTORY');
    expect(wire.match(/"baseline":/g)).toHaveLength(1);

    if (mode === 'approval') {
      const pause = chunks.find(
        (chunk) =>
          chunk.type === 'child-continuation-chunk' && chunk.chunk.type === 'tool-approval-required'
      );
      if (
        pause?.type !== 'child-continuation-chunk' ||
        pause.chunk.type !== 'tool-approval-required'
      ) {
        throw new Error('Missing actual child approval');
      }
      expect(effect).not.toHaveBeenCalled();
      const callsBeforeDiscovery = modelCalls;
      const discovery = await runDiscoveryRequest({
        method: 'GET',
        url: '/assistant/suspended-runs?resourceId=owner&threadId=root',
      });
      expect(discovery.status).toBe(200);
      expect(JSON.parse(discovery.body)).toMatchObject({
        approvals: [
          {
            continuationId: input.id,
            runId: pause.nativeRunId,
            toolCallId: pause.chunk.toolCallId,
          },
        ],
        suspends: [],
      });
      expect(modelCalls).toBe(callsBeforeDiscovery);
      expect(effect).not.toHaveBeenCalled();

      const repository = createPgliteAssistantThreadRepository(database as DbHandle);
      await repository.completeThreadRun('wake-host', { status: 'completed' });
      await repository.createThreadRun({
        childContinuation: { id: input.id, nativeRunId: pause.nativeRunId },
        id: 'resume-host',
        model: 'gpt-5.4',
        provider: 'openai',
        resourceId: 'owner',
        runtimeKind: 'hosted',
        threadId: 'root',
      });
      const resumedBacking = await getDesktopMastraMemory(
        {
          ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
          observationalMemory: {
            ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.observationalMemory,
            enabled: false,
          },
        },
        'resume-host',
        undefined,
        runtime
      );
      await expect(
        streamMastraToolApprovalAction(
          {
            action: 'approve',
            continuationId: input.id,
            runId: pause.nativeRunId,
            toolCallId: 'stale-leaf',
          },
          {
            ...options,
            ...resumedBacking,
            runtime: { ...options.runtime, assistantMessageId: 'stale-parent-outcome' },
          }
        )
      ).rejects.toThrow(
        /^mastra_agent_stream_failure: Suspended approval snapshot is missing the requested tool call or its arguments\.$/
      );
      expect(await graph.getContinuation(scope, input.id)).toMatchObject({
        state: 'awaiting-approval',
      });
      expect(effect).not.toHaveBeenCalled();
      expect(modelCalls).toBe(callsBeforeDiscovery);
      const resumed = await streamMastraToolApprovalAction(
        {
          action: 'approve',
          continuationId: input.id,
          runId: pause.nativeRunId,
          toolCallId: pause.chunk.toolCallId,
        },
        {
          ...options,
          ...resumedBacking,
          runtime: { ...options.runtime, assistantMessageId: 'resumed-parent-outcome' },
        }
      );
      for await (const chunk of resumed) {
        chunks.push(chunk);
      }
      expect(effect).toHaveBeenCalledOnce();
      const afterResume = await runDiscoveryRequest({
        method: 'GET',
        url: '/assistant/suspended-runs?resourceId=owner&threadId=root',
      });
      expect(afterResume.status).toBe(200);
      expect(JSON.parse(afterResume.body)).toEqual({ approvals: [], suspends: [] });
    }
    expect(await graph.getContinuation(scope, input.id)).toMatchObject({
      state: 'completed',
      threadId: 'child',
      turnMessageId: 'new-root-user',
    });
    const history = await backing.memory.recall({
      resourceId: 'child-resource',
      threadId: 'child',
    });
    expect(JSON.stringify(history.messages)).toContain('REAL_CHILD_CONTINUATION');
    expect((await database.query('SELECT * FROM brainstrike_delegated_invocations')).rows).toEqual(
      original.rows
    );
    expect(
      (await database.query('SELECT steps FROM brainstrike_delegation_child_budgets')).rows
    ).toEqual([{ steps: mode === 'approval' ? 2 : 1 }]);
    expect(
      (
        await database.query(
          "SELECT kind FROM brainstrike_assistant_run_events WHERE thread_id='child' AND kind='run.finished'"
        )
      ).rows
    ).toHaveLength(1);
    // Native paused finishes report zero; completed resume reports its accumulated
    // model usage. Preserve those observed totals, not invented per-step deltas.
    expect(
      (
        await database.query(
          'SELECT run_id,input_tokens,output_tokens FROM brainstrike_assistant_run_usage WHERE continuation_id=$1 ORDER BY run_id',
          [input.id]
        )
      ).rows
    ).toEqual(
      mode === 'approval'
        ? [
            { input_tokens: 2, output_tokens: 2, run_id: 'resume-host' },
            { input_tokens: 0, output_tokens: 0, run_id: 'wake-host' },
          ]
        : [{ input_tokens: 1, output_tokens: 1, run_id: 'wake-host' }]
    );
    const finalHost = mode === 'approval' ? 'resume-host' : 'wake-host';
    await expect(
      createDesktopDelegatedConversationHost(database, finalHost).continuation.prepareContinuation({
        ...input,
        id: 'next-explicit-input',
      })
    ).resolves.toMatchObject({ id: 'next-explicit-input' });
  }
);

it.each(['failed', 'cancelled', 'completed'] as const)(
  'settles the projection when native %s arrives without a terminal stream event',
  async (status) => {
    const host = port();
    await host.prepareContinuation(input);
    const bound = await host.bindContinuation({ id: input.id, nativeRunId: 'native-wake' });
    await host.persistContinuationEvent({
      event: {
        id: 'start-without-finish',
        kind: 'run.started',
        label: 'Working',
        status: 'running',
        timestamp: new Date().toISOString(),
      },
      id: input.id,
      messageId: bound.messageId,
      sequence: 0,
    });
    await host.finishContinuation({
      id: input.id,
      status,
      ...(status === 'failed' ? { error: 'Native stream failed' } : {}),
    });
    expect(
      (
        await database.query(
          'SELECT status, completed_at IS NOT NULL AS settled FROM brainstrike_assistant_thread_runs WHERE id=$1',
          [bound.messageId]
        )
      ).rows
    ).toEqual([{ settled: true, status }]);
    await expect(
      host.prepareContinuation({ ...input, id: 'next-explicit-input' })
    ).resolves.toMatchObject({ id: 'next-explicit-input' });
  }
);

it('keeps cancellation authoritative regardless of database UNION row order', async () => {
  const host = port();
  await host.prepareContinuation(input);
  await host.bindContinuation({ id: input.id, nativeRunId: 'native-wake' });
  const query = database.query.bind(database);
  const reversedDatabase = {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT decision.state FROM brainstrike_delegated_continuation_decisions')) {
        return { rows: [{ state: 'cancelled' }, { state: 'claimed' }] };
      }
      return query(sql, params);
    },
  };
  const states = await readDelegatedDecisionStates(reversedDatabase, scope, [
    { continuationId: input.id, runId: 'native-wake', toolCallId: 'leaf-call' },
  ]);
  expect([...states.values()]).toEqual(['cancelled']);
});

it('retains a crashed decision as interrupted even if its native pause may still be saved', async () => {
  const host = port();
  await host.prepareContinuation(input);
  await host.bindContinuation({ id: input.id, nativeRunId: 'native-wake' });
  await host.finishContinuation({ id: input.id, status: 'awaiting-approval' });
  const decision = {
    id: input.id,
    kind: 'tool-approval' as const,
    nativeRunId: 'native-wake',
    toolCallId: 'leaf-call',
  };
  await host.claimContinuationDecision(decision);
  await reapOrphanedThreadRuns(database, new Date(Date.now() + 60_000));
  expect(
    (await database.query('SELECT state FROM brainstrike_delegated_continuation_decisions')).rows
  ).toEqual([{ state: 'interrupted' }]);
  expect(
    (await database.query('SELECT state FROM brainstrike_delegated_continuations')).rows
  ).toEqual([{ state: 'interrupted' }]);
  await expect(host.resolveContinuationDecision(decision)).rejects.toThrow();
  await expect(host.claimContinuationDecision(decision)).rejects.toThrow();
});

it('does not rewrite a completed native projection when Stop races receipt settlement', async () => {
  const host = port();
  await host.prepareContinuation(input);
  const bound = await host.bindContinuation({ id: input.id, nativeRunId: 'native-wake' });
  await host.persistContinuationEvent({
    event: {
      id: 'finished-before-receipt',
      kind: 'run.finished',
      label: 'Finished',
      status: 'completed',
      timestamp: new Date().toISOString(),
    },
    id: input.id,
    messageId: bound.messageId,
    sequence: 0,
  });
  await cancelDelegatedContinuations(database, scope, 'child', false);
  expect(
    (
      await database.query('SELECT status FROM brainstrike_assistant_thread_runs WHERE id=$1', [
        bound.messageId,
      ])
    ).rows
  ).toEqual([{ status: 'completed' }]);
  expect((await database.query('SELECT kind FROM brainstrike_assistant_run_events')).rows).toEqual([
    { kind: 'run.finished' },
  ]);
});

it('rejects root and foreign continuation Stop before calling any native owner', async () => {
  await expect(cancelDelegatedContinuations(database, scope, 'root', true)).rejects.toMatchObject({
    reason: 'continuation-cancel-owner-invalid',
  });
  await expect(
    cancelDelegatedContinuations(database, { ...scope, ownerResourceId: 'foreign' }, 'child', false)
  ).rejects.toMatchObject({ name: 'DelegatedConversationIdentityError' });
  expect(cancel).not.toHaveBeenCalled();
});
