import { NATIVE_TOOL_INPUT_SCHEMAS, registerToolGuardDeadlineSignal } from '@brainstrike/agent';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import { expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { legacyNativeToolPorts } from '../../assistant-server/legacy-native-tool-ports';
import { SEARCH_TOOL_EXECUTORS } from '../../assistant-server/native-tool-executors-search';

const calls = vi.hoisted(() => ({
  hybrid: vi.fn().mockResolvedValue({}),
  semantic: vi.fn().mockResolvedValue({}),
}));
// The executors run the shared retrieval cores; Main supplies its own PGlite store.
vi.mock('../../assistant-server/retrieval-core', async (original) => ({
  ...(await original<typeof import('../../assistant-server/retrieval-core')>()),
  runQueryEmbeddingSpaceWith: calls.semantic,
}));
vi.mock('../../assistant-server/hybrid-search-core', async (original) => ({
  ...(await original<typeof import('../../assistant-server/hybrid-search-core')>()),
  runHybridSearchWith: calls.hybrid,
}));
/** The cores take (input, runtime, dependencies, store, signal). */
const SIGNAL_ARG = 4;
const capability: IndexSearchCapability = {
  coverage: vi.fn(),
  coverageBatch: vi.fn(async () => {
    throw new Error('Unexpected coverage batch');
  }),
  grep: vi.fn(),
  rebuild: vi.fn(),
  search: vi.fn(),
  status: vi.fn(),
};
const embeddingHostManager = { queryEmbedding: vi.fn() };
function entry(
  toolId: typeof NATIVE_TOOL_ID.queryEmbeddingSpace | typeof NATIVE_TOOL_ID.hybridSearch,
  native = true
) {
  const tool = SEARCH_TOOL_EXECUTORS[toolId]({
    dependencies: { embeddingHostManager, ...(native ? { nativeIndexSearch: capability } : {}) },
    isLocalProvider: false,
    ports: legacyNativeToolPorts(undefined),
    readFileCursorRegistry: {} as never,
    resolveActiveDomainCharBudget: () => 6000,
    resolvedDomainCharBudget: 6000,
    runtimeData: undefined,
  });
  if (!tool) {
    throw new Error('Missing retrieval executor');
  }
  return tool as {
    execute: (input: unknown, context: unknown) => Promise<unknown>;
    inputSchema: z.ZodType;
    description: string;
  };
}
it.each([NATIVE_TOOL_ID.queryEmbeddingSpace, NATIVE_TOOL_ID.hybridSearch] as const)(
  'injects the same capability and signal into %s',
  async (toolId) => {
    const signal = new AbortController().signal;
    await entry(toolId).execute(
      { embeddingSetId: 'selected', query: 'marker' },
      { abortSignal: signal }
    );
    const call = (
      toolId === NATIVE_TOOL_ID.queryEmbeddingSpace ? calls.semantic : calls.hybrid
    ).mock.calls.at(-1);
    expect(call?.[2]).toEqual({ embeddingHostManager, nativeIndexSearch: capability });
    expect(call?.[SIGNAL_ARG]).toBe(signal);
  }
);
it.each([NATIVE_TOOL_ID.queryEmbeddingSpace, NATIVE_TOOL_ID.hybridSearch] as const)(
  'passes the guard deadline through %s',
  async (toolId) => {
    const owner = new AbortController();
    const deadline = new AbortController();
    const context = { abortSignal: owner.signal, toolCallId: `guard-${toolId}` };
    const release = registerToolGuardDeadlineSignal([{}, context], deadline.signal);
    try {
      await entry(toolId).execute({ embeddingSetId: 'selected', query: 'marker' }, context);
      const call = (
        toolId === NATIVE_TOOL_ID.queryEmbeddingSpace ? calls.semantic : calls.hybrid
      ).mock.calls.at(-1);
      const signal = call?.[SIGNAL_ARG] as AbortSignal;
      expect(signal.aborted).toBe(false);
      const reason = new Error('guard expired');
      deadline.abort(reason);
      expect(signal.reason).toBe(reason);
      expect(owner.signal.aborted).toBe(false);
    } finally {
      release();
    }
  }
);

it.each([
  [NATIVE_TOOL_ID.queryEmbeddingSpace, { limit: 20 }],
  [NATIVE_TOOL_ID.queryEmbeddingSpace, { filePaths: ['source.ts'] }],
  [NATIVE_TOOL_ID.queryEmbeddingSpace, { selectionSnapshotId: 'snapshot' }],
  [NATIVE_TOOL_ID.hybridSearch, { limit: 20 }],
  [NATIVE_TOOL_ID.hybridSearch, { filePaths: ['source.ts'] }],
  [NATIVE_TOOL_ID.hybridSearch, { chunkType: 'code' }],
  [NATIVE_TOOL_ID.hybridSearch, { ftsWeight: 0.5 }],
  [NATIVE_TOOL_ID.hybridSearch, { vectorWeight: 0 }],
] as const)(
  'native %s rejects unsupported schema and execution inputs %j while PG preserves them',
  async (toolId, options) => {
    const input = { query: 'marker', ...options };
    const native = entry(toolId);
    expect(native.inputSchema.safeParse(input).success).toBe(false);
    await expect(native.execute(input, {})).rejects.toThrow();
    expect(entry(toolId, false).inputSchema.safeParse(input).success).toBe(true);
    expect(NATIVE_TOOL_INPUT_SCHEMAS[toolId].safeParse(input).success).toBe(true);
  }
);
it.each([NATIVE_TOOL_ID.queryEmbeddingSpace, NATIVE_TOOL_ID.hybridSearch] as const)(
  'native %s parses supported input and executes exactly that shape',
  async (toolId) => {
    const tool = entry(toolId);
    const input = { limit: 10, query: 'marker', root: 'actual-root' };
    const parsed = tool.inputSchema.parse(input);
    await tool.execute(parsed, {});
    expect(
      (toolId === NATIVE_TOOL_ID.hybridSearch ? calls.hybrid : calls.semantic).mock.calls.at(
        -1
      )?.[0]
    ).toEqual(input);
  }
);
