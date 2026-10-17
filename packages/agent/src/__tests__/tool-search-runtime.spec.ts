import { NATIVE_TOOL_ID, TOOL_DESCRIPTIONS } from '@brainstrike/assistant-contract';
import { type MastraDBMessage, MessageList } from '@mastra/core/agent';
import type { ProcessInputStepArgs } from '@mastra/core/processors';
import { MASTRA_THREAD_ID_KEY, RequestContext } from '@mastra/core/request-context';
import { createTool, noopObserve } from '@mastra/core/tools';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { MastraAgentError } from '../mastra-boundary/mastra-agent-error';
import { BrainstrikeToolSearchProcessor } from '../mastra-processors/tool-search-runtime';
import { scriptedAgentModel } from '../test-fixtures/scripted-agent-model';

const { model } = scriptedAgentModel(() => {
  throw new Error('Tool discovery must not call the model');
});

const DEFERRED_TOOL_ID = 'brainstrike_listWorkspaceContext';
const LSP_DEFERRED_TOOL_ID = 'brainstrike_lspInspect';
const SECOND_DEFERRED_TOOL_ID = 'brainstrike_readWorkspaceFile';

const RANKING_FIXTURES = [
  {
    expectedToolId: 'brainstrike_listWorkspaceContext',
    query: 'workspace context listing focused root',
  },
  {
    expectedToolId: 'brainstrike_readWorkspaceDirectory',
    query: 'list files in a workspace directory',
  },
  { expectedToolId: 'brainstrike_readWorkspaceFile', query: 'read a workspace file' },
  { expectedToolId: 'brainstrike_grepSearch', query: 'search exact text in files' },
  { expectedToolId: 'brainstrike_globWorkspace', query: 'find files matching a glob pattern' },
  {
    expectedToolId: 'brainstrike_stringReplaceWorkspaceFile',
    query: 'edit an existing workspace file',
  },
  { expectedToolId: 'brainstrike_executeCommand', query: 'run a shell command' },
] as const;

function createRankingProcessor(): BrainstrikeToolSearchProcessor {
  const toolNameMap = new Map<string, string>();
  const deferredTools = Object.fromEntries(
    RANKING_FIXTURES.map(({ expectedToolId }) => {
      const originalToolId = expectedToolId.replace('_', '.');
      toolNameMap.set(expectedToolId, originalToolId);
      return [
        expectedToolId,
        createTool({
          description: TOOL_DESCRIPTIONS[originalToolId as keyof typeof TOOL_DESCRIPTIONS],
          execute: async () => ({}),
          id: expectedToolId,
          inputSchema: z.object({}),
        }),
      ];
    })
  );
  return new BrainstrikeToolSearchProcessor({
    deferredTools,
    model,
    toolNameMap,
  });
}

function createDeferredTool() {
  return createTool({
    description: 'List the files and metadata in the active workspace context.',
    execute: async () => ({ files: ['src/index.ts'] }),
    id: DEFERRED_TOOL_ID,
    inputSchema: z.object({}),
  });
}

function createProcessor(): BrainstrikeToolSearchProcessor {
  return new BrainstrikeToolSearchProcessor({
    deferredTools: { [DEFERRED_TOOL_ID]: createDeferredTool() },
    model,
    toolNameMap: new Map([[DEFERRED_TOOL_ID, 'brainstrike.listWorkspaceContext']]),
  });
}

function createStepArgs(
  options: {
    readonly messageList?: MessageList;
    readonly stepNumber?: number;
    readonly threadId?: unknown;
  } = {}
): ProcessInputStepArgs {
  const messageList = options.messageList ?? new MessageList();
  const requestContext = options.threadId === undefined ? undefined : new RequestContext();
  requestContext?.set(MASTRA_THREAD_ID_KEY, options.threadId);
  return {
    abort(reason?: string): never {
      throw new Error(reason ?? 'processor aborted');
    },
    messageList,
    messages: messageList.get.all.db(),
    model,
    ...(requestContext ? { requestContext } : {}),
    retryCount: 0,
    state: {},
    stepNumber: options.stepNumber ?? 0,
    steps: [],
    systemMessages: [],
    tools: {},
  };
}

/**
 * A `search_tools` result persisted by a pre-BST-1667 auto-load run. Mastra's
 * context store still derives the loaded set from `results[].name`, so threads
 * that loaded tools before the manual-loading switch rehydrate unchanged.
 */
function createLegacyPersistedSearchResultMessage(
  toolId = DEFERRED_TOOL_ID,
  messageId = 'assistant-search-1'
): MastraDBMessage {
  return {
    content: {
      format: 2,
      parts: [
        {
          toolInvocation: {
            args: { query: 'workspace context' },
            result: {
              message: `Found and loaded 1 tool(s): ${toolId}.`,
              results: [
                {
                  description: 'List workspace context',
                  name: toolId,
                  score: 1,
                },
              ],
            },
            state: 'result',
            toolCallId: 'search-1',
            toolName: 'search_tools',
          },
          type: 'tool-invocation',
        },
      ],
    },
    createdAt: new Date(),
    id: messageId,
    role: 'assistant',
  };
}

/**
 * The RUNTIME shape of a persisted `load_tool` success (the single-name form),
 * exactly as Mastra's `load_tool` executor returns it and the context store
 * parses it (`toolName` + `success: true`).
 */
function createPersistedLoadResultMessage(
  toolId = DEFERRED_TOOL_ID,
  messageId = 'assistant-load-1'
): MastraDBMessage {
  return {
    content: {
      format: 2,
      parts: [
        {
          toolInvocation: {
            args: { toolName: toolId },
            result: {
              message: `Tool "${toolId}" loaded successfully.`,
              success: true,
              toolName: toolId,
            },
            state: 'result',
            toolCallId: 'load-1',
            toolName: 'load_tool',
          },
          type: 'tool-invocation',
        },
      ],
    },
    createdAt: new Date(),
    id: messageId,
    role: 'assistant',
  };
}

function createLinearProcessor(): BrainstrikeToolSearchProcessor {
  const descriptions = {
    linear_create_issue_label: 'Create a new Linear issue label.',
    linear_get_issue: 'Retrieve detailed information about an issue by ID.',
    linear_list_issue_labels: 'List available issue labels in a Linear workspace or team.',
    linear_list_issue_statuses: 'List available issue statuses in a Linear team.',
    linear_list_issues:
      'List issues in the workspace. Use query to search titles and descriptions.',
    linear_save_comment: 'Create or update a comment on an issue.',
    linear_save_issue: 'Create or update an issue. When creating, title and team are required.',
  };
  return new BrainstrikeToolSearchProcessor({
    deferredTools: Object.fromEntries(
      Object.entries(descriptions).map(([id, description]) => [
        id,
        createTool({ description, execute: async () => ({}), id, inputSchema: z.object({}) }),
      ])
    ),
    model,
    toolNameMap: new Map(Object.keys(descriptions).map((id) => [id, id.replace('_', '.')])),
  });
}

describe('BrainstrikeToolSearchProcessor', () => {
  it('rejects an eligible catalog entry without its original name mapping', () => {
    expect(
      () =>
        new BrainstrikeToolSearchProcessor({
          deferredTools: { [DEFERRED_TOOL_ID]: createDeferredTool() },
          model,
          toolNameMap: new Map(),
        })
    ).toThrow('missing its original-name mapping');
  });

  it('exposes load_tool and loads only the exact name despite higher-ranking search matches', async () => {
    // BST-1667: exact selection is Mastra's `load_tool`, not a fuzzy search
    // that happens to rank the name first. The distractors out-rank the target
    // on BM25 (their descriptions repeat its tokens), so a search-based load
    // would activate three tools; load_tool activates exactly one.
    const tools = Object.fromEntries(
      ['foo_target', ...Array.from({ length: 10 }, (_, index) => `distractor_${index}`)].map(
        (id) => [
          id,
          createTool({
            description:
              id === 'foo_target' ? 'Perform the requested operation.' : 'foo target '.repeat(30),
            execute: async () => ({ completed: id }),
            id,
            inputSchema: z.object({}),
          }),
        ]
      )
    );
    const processor = new BrainstrikeToolSearchProcessor({
      deferredTools: tools,
      model,
      toolNameMap: new Map(Object.keys(tools).map((id) => [id, id])),
    });
    const args = createStepArgs({ threadId: 'exact-catalog' });
    const first = await processor.processInputStep(args);
    expect(Object.keys(first.tools)).toEqual(['search_tools', 'load_tool', 'list_available_tools']);
    await expect(
      first.tools.load_tool.execute?.({ toolName: 'foo_target' }, { observe: noopObserve })
    ).resolves.toMatchObject({
      success: true,
      toolName: 'foo_target',
    });
    const next = await processor.processInputStep({ ...args, stepNumber: 1 });
    expect(Object.keys(next.tools)).toEqual([
      'search_tools',
      'load_tool',
      'foo_target',
      'list_available_tools',
    ]);
    expect(
      await processor.getLoadedToolsForRequestContext({
        ...(args.requestContext ? { requestContext: args.requestContext } : {}),
      })
    ).toHaveProperty('foo_target');
  });

  it('rewrites load_tool success copy to the same-response wording and keeps Mastra failure copy', async () => {
    const processor = createProcessor();
    const args = createStepArgs({ threadId: 'load-copy' });
    const { tools } = await processor.processInputStep(args);
    const loaded = await tools.load_tool.execute?.(
      { toolName: DEFERRED_TOOL_ID },
      { observe: noopObserve }
    );
    expect(loaded).toMatchObject({ success: true, toolName: DEFERRED_TOOL_ID });
    expect(loaded?.message).toContain('next step in this same response');
    expect(loaded?.message).not.toContain('next turn');
    const missing = await tools.load_tool.execute?.(
      { toolName: 'brainstrike_nope' },
      { observe: noopObserve }
    );
    expect(missing).toMatchObject({ success: false, toolName: 'brainstrike_nope' });
    expect(missing?.message).toContain('not found');
    const batch = await tools.load_tool.execute?.(
      {
        toolNames: [DEFERRED_TOOL_ID, 'brainstrike_nope'],
      },
      { observe: noopObserve }
    );
    expect(batch).toMatchObject({
      alreadyLoaded: [DEFERRED_TOOL_ID],
      notFound: ['brainstrike_nope'],
    });
    // Mastra's batch result shape the wrapper reads (review of #3049).
    expect(typeof batch?.message).toBe('string');
    if (!(batch && 'success' in batch)) {
      throw new Error('Expected a validated load result');
    }
    expect(typeof batch.success).toBe('boolean');
  });

  it('rewrites the copy of a mixed batch that loaded something even though Mastra reports success:false', async () => {
    const secondTool = createTool({
      description: 'Read a file from the active workspace.',
      execute: async () => ({ content: 'hello' }),
      id: SECOND_DEFERRED_TOOL_ID,
      inputSchema: z.object({}),
    });
    const processor = new BrainstrikeToolSearchProcessor({
      deferredTools: {
        [DEFERRED_TOOL_ID]: createDeferredTool(),
        [SECOND_DEFERRED_TOOL_ID]: secondTool,
      },
      model,
      toolNameMap: new Map([
        [DEFERRED_TOOL_ID, 'brainstrike.listWorkspaceContext'],
        [SECOND_DEFERRED_TOOL_ID, 'brainstrike.readWorkspaceFile'],
      ]),
    });
    const args = createStepArgs({ threadId: 'mixed-batch' });
    const { tools } = await processor.processInputStep(args);
    const batch = await tools.load_tool.execute?.(
      {
        toolNames: [SECOND_DEFERRED_TOOL_ID, 'brainstrike_nope'],
      },
      { observe: noopObserve }
    );
    expect(batch).toMatchObject({
      loaded: [SECOND_DEFERRED_TOOL_ID],
      notFound: ['brainstrike_nope'],
      success: false,
    });
    expect(batch?.message).toContain('next step in this same response');
    expect(batch?.message).not.toContain('next turn');
    const next = await processor.processInputStep({ ...args, stepNumber: 1 });
    expect(Object.keys(next.tools)).toContain(SECOND_DEFERRED_TOOL_ID);
  });

  it('recognizes captured eager tool names and mixed eager/deferred loads without widening authority', async () => {
    const processor = createProcessor();
    const args = {
      ...createStepArgs({ threadId: 'eager-load' }),
      tools: {
        brainstrike_globWorkspace: createDeferredTool(),
        brainstrike_readWorkspaceFile: createDeferredTool(),
      },
    };
    const { tools } = await processor.processInputStep(args);
    for (const toolName of ['brainstrike_globWorkspace', 'brainstrike_readWorkspaceFile']) {
      await expect(
        tools.load_tool.execute?.({ toolName }, { observe: noopObserve })
      ).resolves.toMatchObject({
        success: true,
        toolName,
      });
    }
    await expect(
      tools.load_tool.execute?.(
        {
          toolNames: ['brainstrike_globWorkspace', DEFERRED_TOOL_ID, 'brainstrike_nope'],
        },
        { observe: noopObserve }
      )
    ).resolves.toMatchObject({
      alreadyLoaded: ['brainstrike_globWorkspace'],
      loaded: [DEFERRED_TOOL_ID],
      notFound: ['brainstrike_nope'],
      success: false,
    });
    const next = await processor.processInputStep({ ...args, stepNumber: 1 });
    expect(Reflect.get(next.tools, 'brainstrike_globWorkspace')).toBe(
      args.tools.brainstrike_globWorkspace
    );
    expect(next.tools).toHaveProperty(DEFERRED_TOOL_ID);
    expect(next.tools).not.toHaveProperty('brainstrike_nope');
  });

  it('refuses an exact name that is eligible but not in the deferred catalog', async () => {
    // load_tool can only select from the post-gate catalog the processor was
    // built with; a tool absent from both it and the authorized eager step is unavailable,
    // so exact-name loading widens nothing the fuzzy path did not already
    // reach (review of #3049).
    const processor = createProcessor();
    const args = createStepArgs({ threadId: 'ineligible' });
    const { tools } = await processor.processInputStep(args);
    await expect(
      tools.load_tool.execute?.(
        { toolName: 'brainstrike_executeCommand' },
        { observe: noopObserve }
      )
    ).resolves.toMatchObject({ success: false, toolName: 'brainstrike_executeCommand' });
    const next = await processor.processInputStep({ ...args, stepNumber: 1 });
    expect(Object.keys(next.tools)).toEqual(['search_tools', 'load_tool', 'list_available_tools']);
  });

  it('pages a 61-tool catalog and loads an exact name from the last page', async () => {
    const tools = Object.fromEntries(
      Array.from({ length: 61 }, (_, index) => {
        const id = `linear_action_${String(index).padStart(2, '0')}`;
        return [
          id,
          createTool({
            description: 'A Linear workspace operation.',
            execute: async () => ({ completed: id }),
            id,
            inputSchema: z.object({}),
          }),
        ];
      })
    );
    const processor = new BrainstrikeToolSearchProcessor({
      deferredTools: tools,
      model,
      toolNameMap: new Map(Object.keys(tools).map((id) => [id, id.replace('_', '.')])),
    });
    const args = createStepArgs({ threadId: 'paged-catalog' });
    const first = await processor.processInputStep(args);
    const firstPage = await first.tools.list_available_tools.execute?.({ prefix: 'linear.' });
    expect(firstPage).toMatchObject({ catalogTotal: 61, nextOffset: 50, total: 61 });
    expect(firstPage?.tools).toHaveLength(50);
    const lastPage = await first.tools.list_available_tools.execute?.({
      offset: 50,
      prefix: 'linear.',
    });
    expect(lastPage).toMatchObject({ nextOffset: null, total: 61 });
    expect(lastPage?.tools).toHaveLength(11);
    expect(lastPage?.tools.at(-1)?.name).toBe('linear_action_60');
    expect(
      new Set([...(firstPage?.tools ?? []), ...(lastPage?.tools ?? [])].map(({ name }) => name))
        .size
    ).toBe(61);

    await expect(
      first.tools.load_tool.execute?.({ toolName: 'linear_action_60' }, { observe: noopObserve })
    ).resolves.toMatchObject({ success: true, toolName: 'linear_action_60' });
    const next = await processor.processInputStep({ ...args, stepNumber: 1 });
    expect(Object.keys(next.tools)).toEqual([
      'search_tools',
      'load_tool',
      'linear_action_60',
      'list_available_tools',
    ]);
    expect(JSON.stringify(lastPage)).not.toContain('inputSchema');
    await expect(first.tools.list_available_tools.execute?.({ offset: 62 })).rejects.toThrow(
      'offset exceeds'
    );
  });

  it('bounds inventory descriptions without splitting Unicode code points and reports invalid offsets', async () => {
    const tool = createTool({
      description: `${'a'.repeat(159)}🧭end`,
      id: 'unicode_tool',
      inputSchema: z.object({}),
    });
    const processor = new BrainstrikeToolSearchProcessor({
      deferredTools: { unicode_tool: tool },
      model,
      toolNameMap: new Map([['unicode_tool', 'unicode_tool']]),
    });
    const { tools } = await processor.processInputStep(createStepArgs());
    await expect(tools.list_available_tools.execute?.({})).resolves.toMatchObject({
      tools: [
        { description: `${'a'.repeat(159)}🧭`, descriptionTruncated: true, name: 'unicode_tool' },
      ],
    });
    await expect(tools.list_available_tools.execute?.({ offset: 2 })).rejects.toMatchObject({
      code: 'mastra_agent_tool_discovery_failure',
      context: { matchingTotal: 1, offset: 2, phase: 'catalog-pagination' },
    });
  });

  it('orders names independently of locale and treats the exact end as an empty page', async () => {
    const tools = Object.fromEntries(
      ['linear_a', 'linear_B'].map((id) => [id, createDeferredTool()])
    );
    const processor = new BrainstrikeToolSearchProcessor({
      deferredTools: tools,
      model,
      toolNameMap: new Map(Object.keys(tools).map((id) => [id, id])),
    });
    const { tools: controls } = await processor.processInputStep(createStepArgs());
    const page = await controls.list_available_tools.execute?.({ prefix: 'linear' });
    expect(page?.tools.map((t) => t.name)).toEqual(['linear_B', 'linear_a']);
    await expect(
      controls.list_available_tools.execute?.({ offset: 2, prefix: 'linear' })
    ).resolves.toMatchObject({ nextOffset: null, tools: [], total: 2 });
  });

  it('keeps catalog membership scoped to each runtime', async () => {
    const first = await createLinearProcessor().processInputStep(createStepArgs());
    const other = await createProcessor().processInputStep(createStepArgs());
    await expect(
      other.tools.list_available_tools.execute?.({ prefix: 'linear' })
    ).resolves.toMatchObject({ nextOffset: null, tools: [], total: 0 });
    await expect(
      first.tools.list_available_tools.execute?.({ prefix: 'LINEAR_SAVE' })
    ).resolves.toMatchObject({ total: 2 });
    expect(other.tools.list_available_tools).not.toBe(first.tools.list_available_tools);
  });

  it('enumerates all eligible Linear tools without loading their schemas', async () => {
    const processor = createLinearProcessor();
    const first = await processor.processInputStep(createStepArgs({ threadId: 'inventory' }));
    const catalog = first.tools.list_available_tools;
    expect(catalog).toBeDefined();
    const result = await catalog?.execute?.({ prefix: 'linear' });
    expect(result).toMatchObject({
      nextOffset: null,
      tools: expect.arrayContaining([
        expect.objectContaining({ name: 'linear_list_issues' }),
        expect.objectContaining({ name: 'linear_save_issue' }),
        expect.objectContaining({ name: 'linear_save_comment' }),
      ]),
      total: 7,
    });
    const next = await processor.processInputStep(
      createStepArgs({ stepNumber: 1, threadId: 'inventory' })
    );
    expect(Object.keys(next.tools)).toEqual(['search_tools', 'load_tool', 'list_available_tools']);
  });

  it('does not present three Linear search matches as the complete available catalog', async () => {
    const processor = createLinearProcessor();
    const step = await processor.processInputStep(createStepArgs());
    const result = (await step.tools.search_tools.execute?.(
      {
        query: 'Linear issue tracker tools',
      },
      { observe: noopObserve }
    )) as { message: string; results: { name: string }[] };

    expect(result.results).toHaveLength(3);
    expect(result.message).toContain('not the complete catalog');
    expect(result.message).toContain('7 eligible deferred tools');
    expect(result.message).toContain('list_available_tools');
  });

  it.each(RANKING_FIXTURES)(
    'ranks $expectedToolId first for "$query"',
    async ({ expectedToolId, query }) => {
      const processor = createRankingProcessor();
      const step = await processor.processInputStep(createStepArgs());

      const result = (await step.tools.search_tools.execute?.(
        { query },
        { observe: noopObserve }
      )) as {
        results: { name: string }[];
      };

      expect(result.results[0]?.name).toBe(expectedToolId);
    }
  );

  it('derives the search surface description from the ACTUAL deferred set', async () => {
    // Review of #2625: this description carried its own hand-written family
    // list — the OTHER place a model looks to decide whether searching for a
    // capability is worthwhile — and it never mentioned canvas or skill
    // scripts. It now derives per run from deferred-capability-families.ts,
    // so it names exactly the families this fixture's deferred tools make
    // real, and no others.
    const processor = createRankingProcessor();
    const step = await processor.processInputStep(createStepArgs());

    const description = String(step.tools.search_tools.description);
    expect(description).toContain('workspace context');
    expect(description).toContain('directory listings');
    expect(description).not.toContain('canvas documents');
    expect(description).toContain('load_tool');
    expect(description).toContain('does not load them');
    expect(description).not.toContain('next turn');
  });

  it('rewrites the loaded-result copy so the model calls the match in THIS response', async () => {
    // Field failure (2026-09-02, live Linear proof): Mastra's result text
    // "They are available on your next turn — call them directly." made the
    // model end its reply to wait for a user turn; the loaded tool was in the
    // very next step and was never called. Brainstrike owns the executor, so
    // the model-facing sentence is Brainstrike's: same response, next step,
    // do not end the reply.
    const processor = createRankingProcessor();
    const step = await processor.processInputStep(createStepArgs());

    const result = (await step.tools.search_tools.execute?.(
      { query: 'workspace context' },
      { observe: noopObserve }
    )) as {
      message: string;
      results: { name: string }[];
    };

    expect(result.results.length).toBeGreaterThan(0);
    expect(result.message).toContain(result.results[0]?.name ?? '');
    expect(result.message).toContain('same response');
    expect(result.message).toContain('do not end your reply');
    expect(result.message).not.toContain('next turn');
  });

  it("keeps Mastra's no-match copy when the search loads nothing", async () => {
    // Review of #2912: an unconditional rewrite would tell the model that
    // zero tools are "callable now". The rewrite applies only to a loaded
    // result; a miss returns Mastra's own message untouched.
    const processor = createProcessor();
    const step = await processor.processInputStep(createStepArgs());

    const result = (await step.tools.search_tools.execute?.(
      {
        query: 'zzqx qqzz',
      },
      { observe: noopObserve }
    )) as { message: string; results: unknown[] };

    expect(result.results).toEqual([]);
    expect(result.message).toContain('No tools found');
    expect(result.message).not.toContain('same response');
  });

  it('observes the exact query and original ranked ids without schemas', async () => {
    const processor = createRankingProcessor();
    const observations: unknown[] = [];
    const unsubscribe = processor.subscribeSearchObservations((observation) => {
      observations.push(observation);
    });
    const step = await processor.processInputStep(createStepArgs({ stepNumber: 4 }));

    await step.tools.search_tools.execute?.(
      { query: 'workspace context listing focused root' },
      { observe: noopObserve }
    );
    unsubscribe();

    expect(observations).toEqual([
      {
        query: 'workspace context listing focused root',
        rankedResults: expect.arrayContaining([
          {
            score: expect.any(Number),
            toolId: 'brainstrike.listWorkspaceContext',
          },
        ]),
        stepNumber: 4,
      },
    ]);
    expect(JSON.stringify(observations)).not.toContain('inputSchema');
  });

  it('preserves the Mastra search-tool prototype and own property descriptors', async () => {
    const processor = createProcessor();
    const prototype = {
      compatibilityMarker(): string {
        return 'mastra-search-tool';
      },
    };
    const mastraSearchTool = createTool({
      description: 'Mastra search tool',
      execute: async ({ query }: { query: string }) => ({
        message: `Found ${query}`,
        results: [],
      }),
      id: 'search_tools',
      inputSchema: z.object({ query: z.string() }),
    });
    Object.setPrototypeOf(mastraSearchTool, prototype);
    Object.defineProperty(mastraSearchTool, 'compatibilityMetadata', {
      configurable: false,
      enumerable: false,
      value: 'preserve-me',
      writable: false,
    });
    const originalExecute = mastraSearchTool.execute;
    const mastraLoadTool = createTool({
      description: 'Mastra load tool',
      execute: async () => ({ message: 'unused', success: false }),
      id: 'load_tool',
      inputSchema: z.object({ toolName: z.string().optional() }),
    });
    Reflect.set(processor, 'delegate', {
      processInputStep: async () => ({
        tools: { load_tool: mastraLoadTool, search_tools: mastraSearchTool },
      }),
    });

    const result = await processor.processInputStep(createStepArgs());
    const wrappedSearchTool = result.tools.search_tools;

    expect(Object.getPrototypeOf(wrappedSearchTool)).toBe(prototype);
    expect(Object.getOwnPropertyDescriptor(wrappedSearchTool, 'compatibilityMetadata')).toEqual({
      configurable: false,
      enumerable: false,
      value: 'preserve-me',
      writable: false,
    });
    expect(mastraSearchTool.execute).toBe(originalExecute);
    await expect(
      wrappedSearchTool.execute?.({ query: 'workspace' }, { observe: noopObserve })
    ).resolves.toMatchObject({
      results: [],
    });
  });

  it('does not let an observer failure abort successful tool discovery', async () => {
    const processor = createRankingProcessor();
    const observations: unknown[] = [];
    processor.subscribeSearchObservations(() => {
      throw new Error('observer failed');
    });
    processor.subscribeSearchObservations((observation) => {
      observations.push(observation);
    });
    const step = await processor.processInputStep(createStepArgs());

    await expect(
      step.tools.search_tools.execute?.(
        { query: 'workspace context listing focused root' },
        { observe: noopObserve }
      )
    ).resolves.toEqual(expect.objectContaining({ results: expect.any(Array) }));
    expect(observations).toHaveLength(1);
  });

  it('loads lspInspect for the common LSP acronym query', async () => {
    const lspTool = createTool({
      description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.lspInspect],
      execute: async () => ({ available: true }),
      id: LSP_DEFERRED_TOOL_ID,
      inputSchema: z.object({}),
    });
    const processor = new BrainstrikeToolSearchProcessor({
      deferredTools: { [LSP_DEFERRED_TOOL_ID]: lspTool },
      model,
      toolNameMap: new Map([[LSP_DEFERRED_TOOL_ID, NATIVE_TOOL_ID.lspInspect]]),
    });
    const first = await processor.processInputStep(createStepArgs({ threadId: 'lsp-thread' }));

    await expect(
      first.tools.search_tools.execute?.({ query: 'lsp' }, { observe: noopObserve })
    ).resolves.toMatchObject({
      results: [{ name: LSP_DEFERRED_TOOL_ID }],
    });
  });

  it('starts with the meta-tools, search only discovers, and load_tool appends the deferred tool', async () => {
    const processor = createProcessor();
    const first = await processor.processInputStep(createStepArgs({ threadId: 'thread-1' }));

    expect(Object.keys(first.tools)).toEqual(['search_tools', 'load_tool', 'list_available_tools']);
    await expect(
      first.tools.search_tools.execute?.({ query: 'workspace context' }, { observe: noopObserve })
    ).resolves.toMatchObject({
      results: [{ name: DEFERRED_TOOL_ID }],
    });

    // Manual loading (BST-1667): a search result is discovery, not activation.
    const second = await processor.processInputStep(
      createStepArgs({ stepNumber: 1, threadId: 'thread-1' })
    );
    expect(Object.keys(second.tools)).toEqual([
      'search_tools',
      'load_tool',
      'list_available_tools',
    ]);

    await expect(
      second.tools.load_tool.execute?.({ toolName: DEFERRED_TOOL_ID }, { observe: noopObserve })
    ).resolves.toMatchObject({ success: true, toolName: DEFERRED_TOOL_ID });
    const third = await processor.processInputStep(
      createStepArgs({ stepNumber: 2, threadId: 'thread-1' })
    );
    expect(Object.keys(third.tools)).toEqual([
      'search_tools',
      'load_tool',
      DEFERRED_TOOL_ID,
      'list_available_tools',
    ]);
  });

  it('reports each newly loaded deferred definition once per thread', async () => {
    const onToolsLoaded = vi.fn();
    const processor = new BrainstrikeToolSearchProcessor({
      deferredTools: { [DEFERRED_TOOL_ID]: createDeferredTool() },
      model,
      onToolsLoaded,
      toolNameMap: new Map([[DEFERRED_TOOL_ID, 'brainstrike.listWorkspaceContext']]),
    });
    const first = await processor.processInputStep(createStepArgs({ threadId: 'thread-1' }));
    expect(onToolsLoaded).not.toHaveBeenCalled();
    await first.tools.load_tool.execute?.({ toolName: DEFERRED_TOOL_ID }, { observe: noopObserve });

    await processor.processInputStep(createStepArgs({ stepNumber: 1, threadId: 'thread-1' }));
    await processor.processInputStep(createStepArgs({ stepNumber: 2, threadId: 'thread-1' }));

    expect(onToolsLoaded).toHaveBeenCalledTimes(1);
    expect(Object.keys(onToolsLoaded.mock.calls[0]?.[0] ?? {})).toEqual([DEFERRED_TOOL_ID]);
  });

  it.each([
    { fixture: createPersistedLoadResultMessage, label: 'load_tool' },
    { fixture: createLegacyPersistedSearchResultMessage, label: 'legacy auto-load search_tools' },
  ])(
    'reconstructs loaded tools from persisted $label results after processor restart',
    async ({ fixture }) => {
      const persistedMessages = new MessageList();
      persistedMessages.add(fixture(), 'memory');

      const restartedProcessor = createProcessor();
      const result = await restartedProcessor.processInputStep(
        createStepArgs({ messageList: persistedMessages, threadId: 'thread-1' })
      );

      expect(Object.keys(result.tools)).toEqual([
        'search_tools',
        'load_tool',
        DEFERRED_TOOL_ID,
        'list_available_tools',
      ]);
    }
  );

  it('rehydrates loaded tools directly for a fresh approval runtime', async () => {
    const processor = new BrainstrikeToolSearchProcessor({
      deferredTools: { [DEFERRED_TOOL_ID]: createDeferredTool() },
      loadPersistedMessages: async () => [createPersistedLoadResultMessage()],
      model,
      toolNameMap: new Map([[DEFERRED_TOOL_ID, 'brainstrike.listWorkspaceContext']]),
    });

    await expect(processor.getLoadedToolsForRequestContext()).resolves.toHaveProperty(
      DEFERRED_TOOL_ID
    );
    const step = await processor.processInputStep(createStepArgs());
    expect(step.tools).toHaveProperty('list_available_tools');
  });

  it('pins Mastra context storage as empty-or-complete for loaded approval tools', async () => {
    const alphaToolId = 'brainstrike_alphaWorkspaceTool';
    const betaToolId = 'brainstrike_betaWorkspaceTool';
    const processor = new BrainstrikeToolSearchProcessor({
      deferredTools: {
        [alphaToolId]: createTool({
          description: 'Perform the unique alpha workspace operation.',
          execute: async () => ({ ok: true }),
          id: alphaToolId,
          inputSchema: z.object({}),
        }),
        [betaToolId]: createTool({
          description: 'Perform the unique beta workspace operation.',
          execute: async () => ({ ok: true }),
          id: betaToolId,
          inputSchema: z.object({}),
        }),
      },
      loadPersistedMessages: async () => {
        throw new Error('durable recall must not run for a non-empty same-process set');
      },
      model,
      toolNameMap: new Map([
        [alphaToolId, 'brainstrike.alphaWorkspaceTool'],
        [betaToolId, 'brainstrike.betaWorkspaceTool'],
      ]),
    });
    const firstArgs = createStepArgs({ threadId: 'complete-loaded-set' });
    const first = await processor.processInputStep(firstArgs);
    await first.tools.load_tool.execute?.({ toolName: alphaToolId }, { observe: noopObserve });
    const second = await processor.processInputStep(
      createStepArgs({ stepNumber: 1, threadId: 'complete-loaded-set' })
    );
    await second.tools.load_tool.execute?.({ toolName: betaToolId }, { observe: noopObserve });

    const loadedTools = await processor.getLoadedToolsForRequestContext({
      ...(firstArgs.requestContext ? { requestContext: firstArgs.requestContext } : {}),
    });

    expect(Object.keys(loadedTools).sort()).toEqual([alphaToolId, betaToolId]);
  });

  it('fails visibly when approval-runtime hydration cannot recall persisted messages', async () => {
    const processor = new BrainstrikeToolSearchProcessor({
      deferredTools: { [DEFERRED_TOOL_ID]: createDeferredTool() },
      loadPersistedMessages: () => Promise.reject(new Error('thread recall failed')),
      model,
      toolNameMap: new Map([[DEFERRED_TOOL_ID, 'brainstrike.listWorkspaceContext']]),
    });

    await expect(processor.getLoadedToolsForRequestContext()).rejects.toMatchObject({
      code: 'mastra_agent_tool_discovery_failure',
      context: { phase: 'resume-loaded-tools' },
      message: expect.stringContaining('thread recall failed'),
    });
  });

  it('unions sequential disjoint persisted load results within one thread', async () => {
    const secondTool = createTool({
      description: 'Read a file from the active workspace.',
      execute: async () => ({ content: 'hello' }),
      id: SECOND_DEFERRED_TOOL_ID,
      inputSchema: z.object({}),
    });
    const processor = new BrainstrikeToolSearchProcessor({
      deferredTools: {
        [DEFERRED_TOOL_ID]: createDeferredTool(),
        [SECOND_DEFERRED_TOOL_ID]: secondTool,
      },
      model,
      toolNameMap: new Map([
        [DEFERRED_TOOL_ID, 'brainstrike.listWorkspaceContext'],
        [SECOND_DEFERRED_TOOL_ID, 'brainstrike.readWorkspaceFile'],
      ]),
    });
    const persistedMessages = new MessageList();
    persistedMessages.add(createPersistedLoadResultMessage(), 'memory');
    await processor.processInputStep(
      createStepArgs({ messageList: persistedMessages, threadId: 'thread-1' })
    );
    persistedMessages.add(
      createPersistedLoadResultMessage(SECOND_DEFERRED_TOOL_ID, 'assistant-load-2'),
      'memory'
    );

    const result = await processor.processInputStep(
      createStepArgs({ messageList: persistedMessages, stepNumber: 1, threadId: 'thread-1' })
    );

    expect(Object.keys(result.tools)).toEqual([
      'search_tools',
      'load_tool',
      DEFERRED_TOOL_ID,
      SECOND_DEFERRED_TOOL_ID,
      'list_available_tools',
    ]);
  });

  it('does not share anonymous loaded state through a default thread', async () => {
    const processor = createProcessor();
    const first = await processor.processInputStep(createStepArgs());
    await first.tools.load_tool.execute?.({ toolName: DEFERRED_TOOL_ID }, { observe: noopObserve });

    const unrelatedAnonymousStep = await processor.processInputStep(createStepArgs());
    expect(Object.keys(unrelatedAnonymousStep.tools)).toEqual([
      'search_tools',
      'load_tool',
      'list_available_tools',
    ]);
  });

  it('fails visibly when request context contains an invalid thread id', async () => {
    const processor = createProcessor();

    await expect(
      processor.processInputStep(createStepArgs({ threadId: 42 }))
    ).rejects.toMatchObject({
      code: 'mastra_agent_tool_discovery_failure',
      context: { phase: 'context-trimming' },
    });
  });

  it('fails visibly when context trimming removes a loaded-tool result mid-runtime', async () => {
    const processor = createProcessor();
    const persistedMessages = new MessageList();
    persistedMessages.add(createPersistedLoadResultMessage(), 'memory');
    await processor.processInputStep(
      createStepArgs({ messageList: persistedMessages, threadId: 'thread-1' })
    );

    let received: unknown;
    try {
      await processor.processInputStep(createStepArgs({ stepNumber: 1, threadId: 'thread-1' }));
    } catch (error) {
      received = error;
    }

    expect(received).toBeInstanceOf(MastraAgentError);
    expect(received).toMatchObject({
      code: 'mastra_agent_tool_discovery_failure',
      context: {
        invalidatedToolIds: ['brainstrike.listWorkspaceContext'],
        phase: 'context-trimming',
      },
    });
  });
});
