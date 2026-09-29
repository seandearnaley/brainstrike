// @vitest-environment node
import type { StreamChunk } from '@brainstrike/agent';
import {
  parallelToolCallParts,
  scriptedAgentModel,
  textParts,
  toolCallParts,
} from '@brainstrike/agent/test-fixtures/scripted-agent-model';
import { buildNativeToolRiskMap, getToolActionTarget } from '@brainstrike/assistant-contract';
import { DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS } from '@brainstrike/assistant-contract/memory-settings';
import {
  type AssistantPersonaDefinition,
  BUILT_IN_PERSONAS,
} from '@brainstrike/assistant-contract/personas';
import type { PermissionToolGateSnapshot } from '@brainstrike/assistant-contract/tool-metadata';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { getDesktopMastraMemory } from '../../assistant-server/mastra-memory';
import {
  observeDesktopAssistantRunEvents,
  persistDesktopChildRunUsage,
} from '../../assistant-server/run-persistence';
import { createApprovalDatabase } from './fixtures/delegated-approval-harness';

const holder = vi.hoisted(
  (): {
    database: PGlite | undefined;
    model: ReturnType<typeof scriptedAgentModel>['model'] | undefined;
  } => ({ database: undefined, model: undefined })
);
vi.mock('../../db-main', () => ({
  getDatabase: async () => {
    if (!holder.database) {
      throw new Error('Database not initialized');
    }
    return holder.database;
  },
}));
vi.mock('@brainstrike/agent', async (original) => ({
  ...(await original<typeof import('@brainstrike/agent')>()),
}));
vi.mock('@brainstrike/agent/providers/provider-factory', async (original) => ({
  ...(await original<{ createProvider: typeof import('@brainstrike/agent')['createProvider'] }>()),
  createProvider: () => {
    if (!holder.model) {
      throw new Error('Model not initialized');
    }
    return holder.model;
  },
}));

const explore: AssistantPersonaDefinition = {
  allowedToolIds: ['brainstrike.grepSearch'],
  description: 'Inspect the workspace.',
  id: 'explore',
  instructions: 'Report evidence.',
  label: 'Explorer',
  maxSteps: 3,
};
const worker = BUILT_IN_PERSONAS.find((persona) => persona.id === 'worker');
const EMBEDDING_FEEDBACK =
  'Subagent could not start because semantic recall could not check its embedding provider. Check the embedding provider configuration and availability, then retry in a new run.';
const policy: PermissionToolGateSnapshot = {
  policies: { edit: 'ask', execute: 'ask', mcp: 'allow', read: 'allow' },
  riskByTool: buildNativeToolRiskMap(),
  yolo: false,
};
const settings = {
  ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
  observationalMemory: {
    ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.observationalMemory,
    enabled: false,
  },
};

afterEach(async () => {
  vi.restoreAllMocks();
  await holder.database?.close();
  holder.database = undefined;
  holder.model = undefined;
});

async function runApprovalResume(failResumeProbe: boolean): Promise<void> {
  const { streamMastraAgent, streamMastraToolApprovalAction } = await import('@brainstrike/agent');
  if (!worker) {
    throw new Error('Built-in Worker is unavailable');
  }
  const database = await createApprovalDatabase(
    `memory://worker-after-root-approval-${failResumeProbe ? 'failed' : 'healthy'}`
  );
  holder.database = database;
  const childCalls: string[] = [];
  const embeddingCalls: { hostRunId: string; values: string[] }[] = [];
  let rootPhase = 0;
  let retryHostActive = false;
  let retryStarted = false;
  let retrySawFeedback = false;
  let sawWorkerFailureWakeup = false;
  let sameWakeupSawFeedback = false;
  holder.model = scriptedAgentModel((options) => {
    const lastUser = JSON.stringify(
      options.prompt.filter((message) => message.role === 'user').at(-1)
    );
    if (
      retryHostActive &&
      (lastUser.includes('Retry workers after fixing embeddings') ||
        lastUser.includes('Background invocations of this turn'))
    ) {
      retrySawFeedback ||= JSON.stringify(options.prompt).includes(EMBEDDING_FEEDBACK);
      if (retryStarted) {
        return textParts('ROOT_RECEIVED_RETRIED_WORKERS');
      }
      retryStarted = true;
      return parallelToolCallParts([
        {
          args: { prompt: 'Change frontend.' },
          toolCallId: 'worker-retry-front',
          toolName: 'agent-worker',
        },
        {
          args: { prompt: 'Change backend.' },
          toolCallId: 'worker-retry-back',
          toolName: 'agent-worker',
        },
      ]);
    }
    if (
      lastUser.includes('Audit and then delegate changes.') ||
      lastUser.includes('Background invocations of this turn')
    ) {
      if (lastUser.includes('worker-front') && lastUser.includes('failed')) {
        sawWorkerFailureWakeup = true;
        sameWakeupSawFeedback ||= JSON.stringify(options.prompt).includes(EMBEDDING_FEEDBACK);
      }
      rootPhase += 1;
      if (rootPhase === 1) {
        return parallelToolCallParts([
          {
            args: { prompt: 'Audit frontend.' },
            toolCallId: 'explore-front',
            toolName: 'agent-explore',
          },
          {
            args: { prompt: 'Audit backend.' },
            toolCallId: 'explore-back',
            toolName: 'agent-explore',
          },
        ]);
      }
      if (rootPhase === 2) {
        return toolCallParts('brainstrike_writeWorkspaceFile', 'root-approval', {});
      }
      if (rootPhase === 3) {
        return parallelToolCallParts([
          {
            args: {
              instructions: 'Use the focused workspace root. Preserve unrelated edits.',
              maxSteps: 12,
              prompt: 'Change frontend.',
              resourceId: null,
              threadId: null,
            },
            toolCallId: 'worker-front',
            toolName: 'agent-worker',
          },
          {
            args: {
              instructions: 'Use the focused workspace root. Preserve unrelated edits.',
              maxSteps: 14,
              prompt: 'Change backend.',
              resourceId: null,
              threadId: null,
            },
            toolCallId: 'worker-back',
            toolName: 'agent-worker',
          },
        ]);
      }
      return textParts('ROOT_RECEIVED_WORKERS');
    }
    if (lastUser.includes('Audit ')) {
      return textParts('EXPLORER_RESULT');
    }
    childCalls.push(lastUser);
    return textParts('WORKER_RESULT');
  }).model;
  const runtimeMemory = { memorySettings: settings, resourceId: 'owner', threadId: 'root' };
  const baseOptions = {
    model: 'test',
    personas: [explore, worker],
    runtime: {
      apiKey: 'test-key',
      memory: runtimeMemory,
      model: 'test',
      permissionPolicy: policy,
      provider: 'openai' as const,
    },
    tools: {
      'brainstrike.grepSearch': {
        description: 'Inspect evidence.',
        execute: async () => ({ found: true }),
        id: 'brainstrike.grepSearch',
        inputSchema: z.object({}),
      },
      'brainstrike.writeWorkspaceFile': {
        description: 'Prepare parent work.',
        execute: async () => ({ ready: true }),
        id: 'brainstrike.writeWorkspaceFile',
        inputSchema: z.object({}),
      },
    },
  };
  const leg = async (hostRunId: string) => {
    const desktopMemory = await getDesktopMastraMemory(settings, hostRunId, undefined, {
      memory: runtimeMemory,
    });
    const { createPgliteMastraMemory } = await import('@brainstrike/agent/pglite-mastra-memory');
    if (!holder.model) {
      throw new Error('Model not initialized');
    }
    const embedder = {
      doEmbed: async ({ values }: { values: string[] }) => {
        embeddingCalls.push({ hostRunId, values });
        return {
          embeddings: values.map(() => [1, 0, 0]),
          usage: { tokens: values.length },
        };
      },
      maxEmbeddingsPerCall: undefined,
      modelId: 'text-embedding-3-small',
      provider: 'openai',
      specificationVersion: 'v2' as const,
      supportsParallelCalls: true,
    };
    const observedMemory = await createPgliteMastraMemory({
      backgroundTaskScope: { resourceId: 'owner', threadId: 'root' },
      backgroundTaskTimeoutMs: 30_000,
      database: database as unknown as Parameters<typeof createPgliteMastraMemory>[0]['database'],
      embedder,
      memorySettings: {
        observationalMemory: {
          ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.observationalMemory,
          modelTarget: 'openai/gpt-5.6-luna',
          retrievalMode: 'vector',
        },
        semanticRecall: {
          ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.semanticRecall,
          enabled: true,
          messageRange: 4,
          topK: 4,
        },
      },
      observationalMemoryModel: holder.model,
      runId: hostRunId,
    });
    if (failResumeProbe && hostRunId === 'resume-host') {
      // Fail only the child input boundary so the parent can consume both failures.
      // This reproduces the saved probe error shape, not a live provider response.
      const originalGetInputProcessors = observedMemory.memory.getInputProcessors.bind(
        observedMemory.memory
      );
      observedMemory.memory.getInputProcessors = async (...args) => {
        const context = args[1]?.get('MastraMemory') as { thread?: { id?: string } } | undefined;
        if (context?.thread?.id?.startsWith('root-')) {
          const providerError = Object.assign(new Error('invalid_api_key'), { statusCode: 401 });
          throw Object.assign(
            new Error('Embedding dimension probe failed', { cause: providerError }),
            {
              id: 'MASTRA_MEMORY_GET_EMBEDDING_DIMENSION_FAILED',
            }
          );
        }
        return originalGetInputProcessors(...args);
      };
    }
    return { ...baseOptions, ...desktopMemory, memory: observedMemory.memory };
  };
  const drain = async (stream: AsyncIterable<StreamChunk>, hostRunId: string) => {
    const chunks: StreamChunk[] = [];
    for await (const chunk of persistDesktopChildRunUsage(
      observeDesktopAssistantRunEvents(stream, hostRunId, [], async () => database),
      hostRunId,
      undefined,
      async () => database,
      true
    )) {
      chunks.push(chunk);
    }
    return chunks;
  };
  const initial = await drain(
    await streamMastraAgent(
      [
        {
          id: 'host-context',
          parts: [{ text: 'Trusted workspace context.', type: 'text' }],
          role: 'system',
        },
        {
          id: 'user-turn',
          parts: [{ text: 'Audit and then delegate changes.', type: 'text' }],
          role: 'user',
        },
      ],
      await leg('host-leg')
    ),
    'host-leg'
  );
  const pending = initial.find((chunk) => chunk.type === 'tool-approval-required');
  if (pending?.type !== 'tool-approval-required') {
    throw new Error(`Missing root approval: ${JSON.stringify(initial)}`);
  }
  await database.query(
    `UPDATE mastra_threads
     SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
       'color', 'violet',
       'operatingRootId', '11111111-1111-4111-8111-111111111111',
       'workingMemory', $1::text
     )
     WHERE id = 'root' AND "resourceId" = 'owner'`,
    [`# Session\n- Active task: ${'review delegated changes. '.repeat(70)}`.slice(0, 1798)]
  );
  await database.exec(`UPDATE brainstrike_assistant_thread_runs SET status='completed' WHERE id='host-leg';
    INSERT INTO brainstrike_assistant_thread_runs
      (id,resource_id,thread_id,provider,model,runtime_kind,status,started_at,created_at,updated_at,turn_message_id,generation_run_id)
    VALUES ('resume-host','owner','root','openai','test','desktop','running',NOW(),NOW(),NOW(),'user-turn','host-leg');`);
  const resumed = await drain(
    await streamMastraToolApprovalAction(
      { ...getToolActionTarget(pending), action: 'approve' },
      await leg('resume-host')
    ),
    'resume-host'
  );
  const invocations = await database.query<{ persona_id: string }>(
    'SELECT persona_id FROM brainstrike_delegated_invocations ORDER BY persona_id'
  );
  const workerInvocations = invocations.rows.filter((row) => row.persona_id === 'worker');
  if (failResumeProbe) {
    const orphaned = await database.query<{ id: string }>(
      `SELECT thread.id FROM mastra_threads thread
       LEFT JOIN brainstrike_delegated_conversations child ON child.thread_id = thread.id
       WHERE thread.id LIKE 'root-%' AND child.thread_id IS NULL`
    );
    expect(orphaned.rows).toHaveLength(2);
    expect(workerInvocations).toHaveLength(0);
    expect(childCalls).toHaveLength(0);
    expect(sawWorkerFailureWakeup).toBe(true);
    expect(sameWakeupSawFeedback).toBe(true);
    expect(embeddingCalls.some((call) => call.hostRunId === 'resume-host')).toBe(true);
    const savedFeedback = await database.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM mastra_messages WHERE thread_id = $1 AND content::text LIKE $2',
      ['root', `%${EMBEDDING_FEEDBACK}%`]
    );
    await database.exec(`INSERT INTO brainstrike_assistant_thread_runs
      (id,resource_id,thread_id,provider,model,runtime_kind,status,started_at,created_at,updated_at,turn_message_id,generation_run_id)
      VALUES ('retry-host','owner','root','openai','test','desktop','running',NOW(),NOW(),NOW(),'retry-user','retry-host');`);
    retryHostActive = true;
    await drain(
      await streamMastraAgent(
        [
          {
            id: 'retry-system',
            parts: [{ text: 'Trusted workspace context.', type: 'text' }],
            role: 'system',
          },
          {
            id: 'retry-user',
            parts: [{ text: 'Retry workers after fixing embeddings.', type: 'text' }],
            role: 'user',
          },
        ],
        await leg('retry-host')
      ),
      'retry-host'
    );
    const retried = await database.query<{ persona_id: string }>(
      "SELECT persona_id FROM brainstrike_delegated_invocations WHERE persona_id = 'worker'"
    );
    expect(retrySawFeedback).toBe(true);
    expect(retried.rows).toHaveLength(2);
    expect(childCalls).toHaveLength(2);
    expect(embeddingCalls.some((call) => call.hostRunId === 'retry-host')).toBe(true);
    expect(savedFeedback.rows[0]?.count).toBeGreaterThan(0);
  } else {
    expect(workerInvocations, JSON.stringify(resumed)).toHaveLength(2);
    expect(childCalls).toHaveLength(2);
  }
  expect(embeddingCalls.length).toBeGreaterThan(0);
}

it('persists two new worker invocations after root approval resume', async () => {
  await runApprovalResume(false);
});

it('exposes an embedding probe failure before either worker is bound', async () => {
  await runApprovalResume(true);
});
