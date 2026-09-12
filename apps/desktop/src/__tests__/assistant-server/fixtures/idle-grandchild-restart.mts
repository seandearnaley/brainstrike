import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  createDelegatedConversationBinding,
  listSuspendedChildContinuation,
  type StreamChunk,
  streamMastraChildFollowup,
  streamMastraToolApprovalAction,
} from '@brainstrike/agent';
import { createPgliteMastraMemory } from '@brainstrike/agent/pglite-mastra-memory';
import { createTool } from '@brainstrike/agent/test-fixtures/delegated-stream';
import {
  hasToolResult,
  scriptedAgentModel,
  textParts,
  toolCallParts,
} from '@brainstrike/agent/test-fixtures/scripted-agent-model';
import { buildNativeToolRiskMap } from '@brainstrike/assistant-contract';
import { DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS } from '@brainstrike/assistant-contract/memory-settings';
import { createDelegatedConversationRepository, migrate } from '@brainstrike/db';
import { createEnginePglite } from '@brainstrike/db/pglite-factory';
import { z } from 'zod';
import { cancelDelegatedContinuations } from '../../../assistant-server/delegated-continuation-cancellation.ts';
import {
  createDesktopDelegatedConversationHost,
  createDesktopDelegatedSuspensionResolver,
} from '../../../assistant-server/delegated-conversation-host.ts';
import { reapOrphanedThreadRuns } from '../../../assistant-server/thread-run-startup-reaper.ts';

const directory = z.string().min(1).parse(process.argv[2]);
const phase = z.enum(['initial', 'resume', 'recover']).parse(process.argv[3]);
const mode = z.enum(['single', 'stop-sibling']).parse(process.argv[4]);
const database = await createEnginePglite({ dataDir: path.join(directory, 'database') });
const scope = { ownerResourceId: 'owner', rootThreadId: 'root' };
const input = {
  id: 'idle-grandchild-input',
  text: 'Continue the saved grandchild task.',
  threadId: 'grandchild',
};
const siblingInput = { ...input, id: 'idle-sibling-input', threadId: 'sibling' };
const selectedInput = mode === 'stop-sibling' ? siblingInput : input;
const persona = {
  allowedToolIds: ['brainstrike.writeWorkspaceFile'],
  description: 'Write the authorized evidence',
  id: 'worker',
  instructions: 'Use the preserved grandchild history.',
  label: 'Worker',
  maxSteps: 8,
  mode: 'worker' as const,
};
await migrate(database);
const graph = createDelegatedConversationRepository(database);
async function createHostRun(id: string, turnMessageId = input.id): Promise<void> {
  await database.query(
    `INSERT INTO brainstrike_assistant_thread_runs(id,resource_id,thread_id,provider,model,runtime_kind,status,started_at,created_at,updated_at,turn_message_id)
    VALUES ($1,'owner','root','openai','gpt-5.4','desktop','running',NOW(),NOW(),NOW(),$2)`,
    [id, turnMessageId]
  );
}
async function completeHostRun(id: string): Promise<void> {
  await database.query(
    "UPDATE brainstrike_assistant_thread_runs SET status='completed',completed_at=NOW() WHERE id=$1",
    [id]
  );
}
if (phase === 'initial') {
  await database.exec(`INSERT INTO mastra_threads(id,"resourceId",title,metadata,"createdAt","updatedAt") VALUES
    ('root','owner','Root','{}',NOW(),NOW()),('child','child-resource','Child','{}',NOW(),NOW()),('grandchild','grandchild-resource','Grandchild','{}',NOW(),NOW()),('sibling','sibling-resource','Sibling','{}',NOW(),NOW());`);
  await graph.registerRoot(scope);
  await createHostRun('original', 'original-human');
  for (const [threadId, parentThreadId, parentRuntimeRunId, nativeRunId] of [
    ['child', 'root', 'original-root-native', 'original-child-native'],
    ['grandchild', 'child', 'original-child-native', 'original-grandchild-native'],
    ['sibling', 'child', 'original-child-native', 'original-sibling-native'],
  ] as const) {
    await graph.createChild(scope, {
      color: 'blue',
      configuration: { maxSteps: 8, persona },
      displayName: threadId,
      parentThreadId,
      resourceId: `${threadId}-resource`,
      threadId,
    });
    const key = {
      parentRuntimeRunId,
      parentToolCallId: `original-${threadId}`,
      personaId: 'worker',
    };
    await graph.createInvocation(scope, {
      ...key,
      hostRunId: 'original',
      parentThreadId,
      threadId,
    });
    await graph.bindInvocationRun(scope, key, nativeRunId, 'original');
  }
  await completeHostRun('original');
  await writeFile(
    path.join(directory, 'original.json'),
    JSON.stringify(
      (await database.query('SELECT * FROM brainstrike_delegated_invocations ORDER BY thread_id'))
        .rows
    )
  );
} else {
  await reapOrphanedThreadRuns(database, new Date());
}
const savedPause =
  phase === 'initial'
    ? undefined
    : z
        .object({ runId: z.string(), stoppedRunId: z.string().optional(), toolCallId: z.string() })
        .parse(JSON.parse(await readFile(path.join(directory, 'pause.json'), 'utf8')));
await createHostRun(phase, phase === 'initial' ? input.id : selectedInput.id);
async function createBacking(runId: string) {
  const memory = await createPgliteMastraMemory({
    backgroundTaskScope: { resourceId: 'owner', threadId: 'root' },
    database: {
      exec: (sql) => database.exec(sql),
      query: (sql, values) => database.query(sql, values ? [...values] : undefined),
      transaction: (operation) =>
        database.transaction((tx) =>
          operation({
            exec: (sql) => tx.exec(sql),
            query: (sql, values) => tx.query(sql, values ? [...values] : undefined),
          })
        ),
    },
    memorySettings: {
      ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
      observationalMemory: {
        ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.observationalMemory,
        enabled: false,
      },
    },
    runId,
  });
  const host = createDesktopDelegatedConversationHost(database, runId);
  const binding = {
    ...createDelegatedConversationBinding(host.persist),
    bindRun: host.bindRun,
    budget: host.budget,
    claimToolAction: host.claimToolAction,
    continuation: host.continuation,
    finishToolActions: host.finishToolActions,
    prepareToolAction: host.prepareToolAction,
    releaseUnexecutedToolAction: host.releaseUnexecutedToolAction,
    resolveToolAction: host.resolveToolAction,
  };
  return { ...memory, conversationBinding: binding, host };
}
const backing = await createBacking(phase);
const host = backing.host;
const binding = backing.conversationBinding;
let childCalls = 0;
let parentCalls = 0;
const model = scriptedAgentModel((options) => {
  if (JSON.stringify(options.prompt).includes('child_continuation_result')) {
    parentCalls += 1;
    return textParts('PARENT_ACKNOWLEDGES_GRANDCHILD');
  }
  childCalls += 1;
  return hasToolResult(options, 'brainstrike_writeWorkspaceFile')
    ? textParts('GRANDCHILD_FINISHED_ONCE')
    : toolCallParts('brainstrike_writeWorkspaceFile', 'same-leaf-call', {
        content: 'once',
        path: '/proof.txt',
      });
});
const options = {
  ...backing,
  conversationBinding: binding,
  getDelegatedSystemContext: () => [],
  modelOverride: model.model,
  personas: [],
  runtime: {
    apiKey: 'test-key',
    assistantMessageId: `${phase}-parent-message`,
    memory: { resourceId: 'owner', threadId: 'root' },
    model: 'gpt-5.4',
    permissionPolicy: {
      policies: {
        edit: 'ask' as const,
        execute: 'deny' as const,
        mcp: 'deny' as const,
        read: 'allow' as const,
      },
      riskByTool: buildNativeToolRiskMap(),
      yolo: false,
    },
    provider: 'openai' as const,
  },
  tools: {
    'brainstrike.writeWorkspaceFile': createTool({
      description: 'Write authorized fixture evidence',
      execute: async () => {
        await writeFile(path.join(directory, 'effect.txt'), 'effect-once', { flag: 'wx' });
        return { written: true };
      },
      id: 'brainstrike.writeWorkspaceFile',
      inputSchema: z.object({ content: z.string(), path: z.string() }),
    }),
  },
};
const chunks: StreamChunk[] = [];
let rejected = false;
try {
  if (phase === 'initial') {
    let stoppedRunId: string | undefined;
    for (const request of mode === 'stop-sibling' ? [input, siblingInput] : [input]) {
      let legBacking = backing;
      if (request.id === siblingInput.id) {
        await completeHostRun('initial');
        await createHostRun('initial-sibling', siblingInput.id);
        legBacking = await createBacking('initial-sibling');
      }
      await legBacking.memory.saveMessages({
        messages: [
          {
            content: { format: 2, parts: [{ text: 'SAVED_GRANDCHILD_CONTEXT', type: 'text' }] },
            createdAt: new Date(),
            id: `saved-${request.threadId}-history`,
            resourceId: `${request.threadId}-resource`,
            role: 'assistant',
            threadId: request.threadId,
            type: 'text',
          },
        ],
      });
      const stream = await streamMastraChildFollowup(request, {
        ...options,
        ...legBacking,
        runtime: { ...options.runtime, assistantMessageId: `${request.id}-parent-message` },
      });
      const leg: StreamChunk[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
        leg.push(chunk);
      }
      assert.deepEqual(
        leg.flatMap((chunk) =>
          chunk.type === 'child-continuation-chunk' && chunk.chunk.type === 'message-finish'
            ? [chunk.chunk.usage]
            : []
        ),
        [{ completionTokens: 1, promptTokens: 1 }]
      );
      const pause = leg.find(
        (chunk) =>
          chunk.type === 'child-continuation-chunk' && chunk.chunk.type === 'tool-approval-required'
      );
      assert(
        pause?.type === 'child-continuation-chunk' && pause.chunk.type === 'tool-approval-required'
      );
      await writeFile(
        path.join(directory, 'pause.json'),
        JSON.stringify({
          runId: pause.nativeRunId,
          stoppedRunId,
          toolCallId: pause.chunk.toolCallId,
        })
      );
      stoppedRunId = pause.nativeRunId;
      assert.equal(
        (
          await legBacking.host.continuation.resolveContinuationDecision({
            id: request.id,
            kind: 'tool-approval',
            nativeRunId: pause.nativeRunId,
            toolCallId: pause.chunk.toolCallId,
          })
        ).depth,
        2
      );
    }
    if (mode === 'stop-sibling') {
      await cancelDelegatedContinuations(database, scope, input.threadId, false);
    }
  } else if (phase === 'resume') {
    assert(savedPause);
    if (mode === 'stop-sibling') {
      assert.equal((await graph.getContinuation(scope, input.id))?.state, 'cancelled');
      assert(savedPause.stoppedRunId);
      await assert.rejects(
        host.continuation.resolveContinuationDecision({
          id: input.id,
          kind: 'tool-approval',
          nativeRunId: savedPause.stoppedRunId,
          toolCallId: savedPause.toolCallId,
        })
      );
      assert.equal(
        (await graph.getContinuation(scope, siblingInput.id))?.state,
        'awaiting-approval'
      );
    }
    const discovered = await listSuspendedChildContinuation(
      {
        continuationId: selectedInput.id,
        nativeRunId: savedPause.runId,
        personaId: 'worker',
        resourceId: `${selectedInput.threadId}-resource`,
        threadId: selectedInput.threadId,
      },
      {
        resolveInvocation: createDesktopDelegatedSuspensionResolver(database, scope),
        storage: backing.storage,
      }
    );
    assert.equal(discovered.approvals.length, 1);
    assert.equal(childCalls + parentCalls, 0);
    const stream = await streamMastraToolApprovalAction(
      {
        action: 'approve',
        continuationId: selectedInput.id,
        runId: savedPause.runId,
        toolCallId: savedPause.toolCallId,
      },
      options
    );
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
  } else {
    assert(savedPause);
    try {
      await streamMastraChildFollowup(selectedInput, options);
    } catch {
      rejected = true;
    }
    assert(rejected);
    assert(savedPause);
    await assert.rejects(
      streamMastraToolApprovalAction(
        {
          action: 'approve',
          continuationId: selectedInput.id,
          runId: savedPause.runId,
          toolCallId: savedPause.toolCallId,
        },
        options
      )
    );
  }
  const receipt = await graph.getContinuation(scope, selectedInput.id);
  const history = await backing.memory.recall({
    resourceId: `${selectedInput.threadId}-resource`,
    threadId: selectedInput.threadId,
  });
  const rootHistory = await backing.memory.recall({ resourceId: 'owner', threadId: 'root' });
  assert.equal(
    JSON.stringify(
      (await database.query('SELECT * FROM brainstrike_delegated_invocations ORDER BY thread_id'))
        .rows
    ),
    await readFile(path.join(directory, 'original.json'), 'utf8'),
    'Original ancestor invocations must remain immutable'
  );
  const usage = (
    await database.query(
      'SELECT usage.run_id,usage.thread_id AS root_thread_id,continuation.thread_id,usage.input_tokens,usage.output_tokens FROM brainstrike_assistant_run_usage usage JOIN brainstrike_delegated_continuations continuation ON continuation.id=usage.continuation_id WHERE usage.continuation_id=ANY($1::text[]) ORDER BY usage.run_id,continuation.thread_id',
      [mode === 'stop-sibling' ? [input.id, siblingInput.id] : [input.id]]
    )
  ).rows;
  const effect = await readFile(path.join(directory, 'effect.txt'), 'utf8').catch(
    (error: unknown) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  );
  await completeHostRun(phase);
  if (phase === 'initial' && mode === 'stop-sibling') {
    await completeHostRun('initial-sibling');
  }
  await writeFile(
    path.join(directory, `${phase}.json`),
    JSON.stringify({
      childCalls,
      effect,
      history: JSON.stringify(history.messages),
      parentCalls,
      pid: process.pid,
      receipt,
      rejected,
      rootHistory: JSON.stringify(rootHistory.messages),
      rootText: chunks
        .filter((chunk) => chunk.type === 'text-delta')
        .map((chunk) => (chunk.type === 'text-delta' ? chunk.value : ''))
        .join(''),
      stoppedState: (await graph.getContinuation(scope, input.id))?.state,
      usage,
    })
  );
} finally {
  await database.close();
}
