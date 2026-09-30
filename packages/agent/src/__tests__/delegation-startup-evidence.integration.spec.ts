import { BUILT_IN_PERSONAS } from '@brainstrike/assistant-contract/personas';
import { DEFAULT_RUNTIME_SUBAGENT_SETTINGS } from '@brainstrike/assistant-contract/subagent-settings';
import { createEnginePglite } from '@brainstrike/db/pglite-factory';
import { addLogListener, createLogger, type LogRecord } from '@brainstrike/logging';
import {
  logRecordToDiagnosticEvent,
  parseDiagnosticEventLine,
  serializeDiagnosticEventLine,
} from '@brainstrike/utils/diagnostics';
import { Agent } from '@mastra/core/agent';
import { InMemoryStore } from '@mastra/core/storage';
import { Memory } from '@mastra/memory';
import { expect, it, vi } from 'vitest';
import { createDelegatedConversationBinding } from '../mastra/delegated-conversation-binding';
import { createDelegationConfig } from '../mastra/subagent-delegation';
import { PgliteVectorStore } from '../pglite-mastra-memory/vector-store';
import {
  hasToolResult,
  scriptedAgentModel,
  textParts,
  toolCallParts,
} from '../test-fixtures/scripted-agent-model';

it.each(['probe', 'persist'] as const)(
  'native Worker startup %s retains bounded diagnostic evidence',
  async (failure) => {
    const worker = BUILT_IN_PERSONAS.find((persona) => persona.id === 'worker');
    if (!worker) {
      throw new Error('Missing worker');
    }
    let childSteps = 0;
    const supervisorPrompts: string[] = [];
    const admitted = vi.fn();
    const binding = {
      ...createDelegatedConversationBinding(async (identity) => {
        if (failure === 'persist') {
          throw Object.assign(new Error('PRIVATE_PROVIDER_RESPONSE'), { statusCode: 503 });
        }
        admitted(identity);
      }),
      bindRun: async () => {
        throw new Error('Unexpected child publication');
      },
      claimToolAction: async () => undefined,
      finishToolActions: async () => undefined,
      prepareToolAction: async () => undefined,
      releaseUnexecutedToolAction: async () => undefined,
      resolveToolAction: async () => [],
    };
    const storage = new InMemoryStore({ id: `startup-${failure}` });
    let database: Awaited<ReturnType<typeof createEnginePglite>> | undefined;
    const memory = new Memory({ options: { generateTitle: false }, storage });
    const embed = vi.fn(async () => {
      throw Object.assign(new Error('PRIVATE_PROVIDER_RESPONSE'), { statusCode: 401 });
    });
    let childMemory = memory;
    const model = scriptedAgentModel((options) => {
      if (!options.tools?.some((tool) => tool.name === 'agent-worker')) {
        childSteps += 1;
        return textParts('UNEXPECTED_CHILD');
      }
      supervisorPrompts.push(JSON.stringify(options.prompt));
      return hasToolResult(options, 'agent-worker')
        ? textParts('ROOT_HANDLED_FAILURE')
        : toolCallParts('agent-worker', `startup-${failure}`, { prompt: 'PRIVATE_TASK' });
    }).model;
    const records: LogRecord[] = [];
    const remove = addLogListener((record) => records.push(record));
    try {
      if (failure === 'probe') {
        const probeDatabase = await createEnginePglite();
        database = probeDatabase;
        childMemory = new Memory({
          embedder: {
            doEmbed: embed,
            maxEmbeddingsPerCall: undefined,
            modelId: 'startup-embedder',
            provider: 'test',
            specificationVersion: 'v2',
            supportsParallelCalls: false,
          },
          options: { generateTitle: false, semanticRecall: true },
          storage,
          vector: new PgliteVectorStore({
            database: {
              exec: (query) => probeDatabase.exec(query),
              query: (query, values) =>
                probeDatabase.query(query, values ? [...values] : undefined),
              transaction: (operation) =>
                probeDatabase.transaction((tx) =>
                  operation({
                    exec: (query) => tx.exec(query),
                    query: (query, values) => tx.query(query, values ? [...values] : undefined),
                  })
                ),
            },
          }),
        });
      }
      const child = new Agent({
        id: 'worker',
        inputProcessors: [binding.inputProcessor],
        instructions: worker.instructions,
        memory: childMemory,
        model,
        name: 'Worker',
      });
      const parent = new Agent({
        agents: { worker: child },
        id: 'parent',
        instructions: 'Delegate.',
        memory,
        model,
        name: 'Parent',
      });
      const config = createDelegationConfig({
        abortSignal: new AbortController().signal,
        conversationBinding: binding,
        logger: createLogger('NativeStartupEvidence'),
        personasById: new Map([['worker', worker]]),
        subagentSettings: DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
      });
      const stream = await parent.stream('Delegate.', {
        delegation: config,
        maxSteps: 2,
        memory: { resource: 'owner', thread: 'root' },
      });
      const chunks = [];
      for await (const chunk of stream.fullStream) {
        chunks.push(chunk);
      }
      await stream.getFullOutput();
      expect(JSON.stringify(chunks)).toContain('ROOT_HANDLED_FAILURE');
    } finally {
      remove();
      try {
        await Promise.all([memory.settled(), childMemory.settled()]);
      } finally {
        await database?.close();
      }
    }
    expect(admitted).not.toHaveBeenCalled();
    expect(childSteps).toBe(0);
    const failures = records.filter((record) => record.message === 'Subagent delegation failed');
    expect(failures).toHaveLength(1);
    const diagnostic =
      failures[0] &&
      logRecordToDiagnosticEvent(failures[0], {
        appVersion: 'test',
        makeId: () => 'diagnostic',
        platform: 'test',
        sessionId: 'session',
        source: 'electron-main',
      });
    expect(diagnostic).toMatchObject({
      context: {
        frameworkErrorIds: expect.arrayContaining(['AGENT_STREAM_FAILED']),
        parentToolCallId: `startup-${failure}`,
        startupBoundary: failure === 'probe' ? 'delegation-prepared' : 'child-input-started',
      },
    });
    if (!diagnostic) {
      throw new Error('Missing native diagnostic');
    }
    expect(parseDiagnosticEventLine(serializeDiagnosticEventLine(diagnostic))).toEqual(diagnostic);
    expect(diagnostic.context?.['httpStatus']).toBe(failure === 'persist' ? 503 : undefined);
    expect(diagnostic.stack).toBeNull();
    expect(diagnostic.causeChain).toBeNull();
    expect(supervisorPrompts.at(-1)).toContain('No admitted child conversation was observed');
    expect(embed).toHaveBeenCalledTimes(failure === 'probe' ? 1 : 0);
    expect(supervisorPrompts.at(-1)).not.toContain('partial results remain');
    expect(JSON.stringify(diagnostic)).not.toMatch(
      /PRIVATE_PROVIDER_RESPONSE|PRIVATE_TASK|test-key/
    );
  }
);
