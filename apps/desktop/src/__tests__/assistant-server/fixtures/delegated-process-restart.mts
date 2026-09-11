import assert from 'node:assert/strict';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  createAskUserTool,
  createDelegatedConversationBinding,
  createSubmitPlanTool,
  type StreamChunk,
} from '@brainstrike/agent';
import { createPgliteMastraMemory } from '@brainstrike/agent/pglite-mastra-memory';
import {
  Agent,
  claimDelegatedToolAction,
  createAttemptDelegatedProjection,
  createResponseBoundaryProcessor,
  createTool,
  createTurnAttemptLifecycleState,
  Mastra,
  processMastraStreamPart,
  sanitizeTools,
} from '@brainstrike/agent/test-fixtures/delegated-stream';
import { toolThenAnswer } from '@brainstrike/agent/test-fixtures/scripted-agent-model';
import { DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS } from '@brainstrike/assistant-contract/memory-settings';
import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract/personas';
import { isAssistantToolApprovalAction } from '@brainstrike/assistant-contract/tool-approval';
import { isAssistantToolResumeAction } from '@brainstrike/assistant-contract/tool-suspend';
import { DelegatedConversationIdentityError, migrate } from '@brainstrike/db';
import { createEnginePglite } from '@brainstrike/db/pglite-factory';
import { z } from 'zod';
import { createDesktopDelegatedConversationHost } from '../../../assistant-server/delegated-conversation-host.ts';
import { reapOrphanedThreadRuns } from '../../../assistant-server/thread-run-startup-reaper.ts';

const directory = z.string().min(1).parse(process.argv[2]);
const phase = z.enum(['initial', 'resume', 'recover']).parse(process.argv[3]);
const decision = z
  .enum(['approve', 'decline', 'interrupt', 'answer', 'plan-approve', 'plan-reject'])
  .parse(process.argv[4]);
const effectFile = path.join(directory, 'effects.txt');
const database = await createEnginePglite({ dataDir: path.join(directory, 'database') });
await migrate(database);
if (phase === 'initial') {
  await writeFile(effectFile, '');
  await database.exec(`INSERT INTO mastra_threads
    (id, "resourceId", title, metadata, "createdAt", "updatedAt")
    VALUES ('root', 'owner', 'Root', '{}', NOW(), NOW())`);
} else {
  // Fixed old run timestamps model a previous boot outside the clock-skew band.
  await reapOrphanedThreadRuns(database, new Date());
}
await database.query(
  `INSERT INTO brainstrike_assistant_thread_runs
  (id, resource_id, thread_id, provider, model, runtime_kind, status,
   started_at, created_at, updated_at, turn_message_id)
  VALUES ($1, 'owner', 'root', 'openai', 'fixture', 'desktop', 'running',
    '2020-01-01', NOW(), NOW(), 'user-turn')`,
  [phase]
);
const memory = await createPgliteMastraMemory({
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
  runId: phase,
});
const authority = createDesktopDelegatedConversationHost(database, phase);
const binding = {
  ...createDelegatedConversationBinding(authority.persist),
  bindRun: authority.bindRun,
  claimToolAction: authority.claimToolAction,
  finishToolActions: authority.finishToolActions,
  releaseUnexecutedToolAction: authority.releaseUnexecutedToolAction,
  resolveToolAction: authority.resolveToolAction,
};
const delegation = {
  hookErrorStrategy: 'throw' as const,
  onDelegationStart: (context: Parameters<typeof binding.prepare>[0]) =>
    binding.prepare(context, { maxSteps: 4, personaId: context.primitiveId }),
};
const boundary = createResponseBoundaryProcessor();
const interactiveTool =
  decision === 'answer'
    ? createAskUserTool()
    : decision.startsWith('plan-')
      ? createSubmitPlanTool()
      : undefined;
const leafToolName = interactiveTool?.id ?? 'read';
const leafInput =
  decision === 'answer'
    ? {
        options: [{ label: 'App' }, { label: 'Docs' }],
        question: 'Which workspace?',
        selectionMode: 'multi_select',
      }
    : interactiveTool
      ? {
          overview: 'Read before changing files.',
          steps: [{ title: 'Read evidence' }],
          title: 'Inspect the workspace',
        }
      : { query: 'needle' };
const toolNameMap = new Map<string, string>();
const leafTools = sanitizeTools(
  interactiveTool
    ? { [leafToolName]: interactiveTool }
    : {
        read: createTool({
          description: 'Read evidence',
          execute: async () => {
            await appendFile(effectFile, 'effect\n');
            return { value: 'APPROVED-EVIDENCE' };
          },
          id: 'read',
          inputSchema: z.object({ query: z.string() }),
          requireApproval: true,
        }),
      },
  toolNameMap
);
const leafToolKey = [...toolNameMap.keys()][0];
assert(leafToolKey);
const leafModel = toolThenAnswer(leafToolKey, 'read-1', leafInput);
const leaf = new Agent({
  description: 'Read evidence',
  id: 'leaf',
  inputProcessors: [binding.inputProcessor],
  instructions: 'Read evidence.',
  memory: memory.memory,
  model: leafModel.model,
  name: 'Leaf',
  outputProcessors: [boundary],
  tools: leafTools,
});
const child = new Agent({
  agents: { leaf },
  defaultOptions: { delegation, hooks: binding.hooks, maxSteps: 4 },
  description: 'Delegate',
  id: 'child',
  inputProcessors: [binding.inputProcessor],
  instructions: 'Delegate to leaf.',
  memory: memory.memory,
  model: toolThenAnswer('agent-leaf', 'leaf-1', { prompt: 'Read' }).model,
  name: 'Child',
  outputProcessors: [boundary],
});
const parent = new Agent({
  agents: { child },
  defaultOptions: { delegation, hooks: binding.hooks, maxSteps: 4 },
  id: 'parent',
  instructions: 'Delegate.',
  memory: memory.memory,
  model: toolThenAnswer('agent-child', 'child-1', { prompt: 'Delegate' }).model,
  name: 'Parent',
});
const mastra = new Mastra({ agents: { parent }, logger: false, storage: memory.storage });
let rejected = false;
try {
  if (phase === 'initial') {
    const native = await parent.stream('Delegate.', {
      memory: { resource: 'owner', thread: 'root' },
    });
    const personas = new Map([
      ['agent-child', 'child'],
      ['agent-leaf', 'leaf'],
    ]);
    const metadata: AssistantPersonaDefinition = {
      allowedToolIds: [leafToolName],
      description: 'Delegate',
      id: 'child',
      instructions: 'Delegate.',
      label: 'Child',
      maxSteps: 4,
    };
    const state = createTurnAttemptLifecycleState(
      { memory: { threadId: 'root' } },
      undefined,
      undefined
    );
    const runtime = {
      askTools: new Map(),
      conversationBinding: binding,
      delegationToolPersonas: personas,
      personasById: new Map([
        ['child', metadata],
        ['leaf', { ...metadata, id: 'leaf' }],
      ]),
    };
    const projection = createAttemptDelegatedProjection({
      lifecycleState: state,
      runtime,
      runtimeData: {
        memory: { resourceId: 'owner', threadId: 'root' },
        model: 'fixture',
        provider: 'openai',
      },
      sanitizedNameMap: undefined,
    });
    const names = new Map<string, string>();
    const chunks: StreamChunk[] = [];
    for await (const part of native.fullStream) {
      await projection.project(part, names);
      const mapped = await processMastraStreamPart(
        projection.preparePart(part),
        names,
        state,
        undefined,
        runtime.askTools,
        personas
      );
      chunks.push(...mapped.chunks.map((chunk) => projection.decorate(chunk)));
    }
    projection.settle();
    assert(
      !chunks.some(
        (chunk) => chunk.type === 'run-event' && chunk.event.kind === 'tool.resume.unsupported'
      )
    );
    const notice = chunks.find(
      (chunk) =>
        chunk.type === (interactiveTool ? 'tool-suspend-required' : 'tool-approval-required')
    );
    assert(
      notice &&
        (notice.type === 'tool-approval-required' || notice.type === 'tool-suspend-required') &&
        notice.delegation
    );
    if (notice.type === 'tool-suspend-required') {
      assert.equal(notice.toolName, leafToolName);
      assert.deepEqual(notice.suspendPayload, leafInput);
    }
    assert.equal(notice.delegation.path.length, 2);
    await writeFile(
      path.join(directory, 'action.json'),
      JSON.stringify({
        ...(interactiveTool
          ? {
              resumeData:
                decision === 'answer'
                  ? { answer: ['App', 'Docs'] }
                  : {
                      action: decision === 'plan-approve' ? 'approved' : 'rejected',
                      feedback: 'Keep the original scope.',
                    },
              toolName: leafToolName,
            }
          : { action: decision === 'decline' ? 'decline' : 'approve' }),
        delegation: notice.delegation,
        runId: native.runId,
        toolCallId: notice.toolCallId,
      })
    );
  } else {
    const action: unknown = JSON.parse(await readFile(path.join(directory, 'action.json'), 'utf8'));
    assert(isAssistantToolApprovalAction(action) || isAssistantToolResumeAction(action));
    assert(action.delegation);
    if (phase === 'recover') {
      // Test durable admission directly; an absent native snapshot cannot mask a
      // missing permanent decision record by rejecting earlier in discovery.
      await assert.rejects(
        binding.claimToolAction(action),
        (error: unknown) =>
          error instanceof DelegatedConversationIdentityError &&
          error.reason === 'tool-action-already-consumed-or-root-busy'
      );
      rejected = true;
    } else {
      await claimDelegatedToolAction(action, binding, {
        agent: parent,
        requiresApproval: !interactiveTool,
      });
      if (decision !== 'interrupt') {
        const target = { runId: action.runId, toolCallId: action.toolCallId };
        const resumed = isAssistantToolResumeAction(action)
          ? await parent.resumeStream(action.resumeData, target)
          : decision === 'approve'
            ? await parent.approveToolCall(target)
            : await parent.declineToolCall(target);
        for await (const part of resumed.fullStream) {
          assert.notEqual(part.type, 'tool-call-suspended');
        }
        assert.equal(await resumed.text, 'child-1 answered');
        await binding.finishToolActions();
      }
      // Interrupt deliberately leaves a durable claimed decision with no native
      // invocation or settlement. The next process must retain it as unknown.
    }
  }
  const decisions = (
    await database.query('SELECT state FROM brainstrike_delegated_tool_decisions ORDER BY id')
  ).rows;
  const effects = (await readFile(effectFile, 'utf8')).split('\n').filter(Boolean).length;
  await writeFile(
    path.join(directory, `${phase}.json`),
    JSON.stringify({
      decisions,
      effects,
      pid: process.pid,
      rejected,
      toolResults: leafModel.prompts.flatMap(({ prompt }) =>
        prompt.flatMap((message) =>
          message.role === 'tool'
            ? message.content.filter((part) => part.toolName === leafToolKey)
            : []
        )
      ),
    })
  );
} finally {
  try {
    await mastra.shutdown();
  } finally {
    await database.close();
  }
}
