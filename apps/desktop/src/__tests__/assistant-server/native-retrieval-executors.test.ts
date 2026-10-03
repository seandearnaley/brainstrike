import { registerToolGuardDeadlineSignal } from '@brainstrike/agent';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import { expect, it, vi } from 'vitest';
import { SEARCH_TOOL_EXECUTORS } from '../../assistant-server/native-tool-executors-search';

const calls = vi.hoisted(() => ({
  hybrid: vi.fn().mockResolvedValue({}),
  semantic: vi.fn().mockResolvedValue({}),
}));
vi.mock('../../assistant-server/retrieval-tool', async (original) => ({
  ...(await original<typeof import('../../assistant-server/retrieval-tool')>()),
  runQueryEmbeddingSpace: calls.semantic,
}));
vi.mock('../../assistant-server/hybrid-search-tool', async (original) => ({
  ...(await original<typeof import('../../assistant-server/hybrid-search-tool')>()),
  runHybridSearch: calls.hybrid,
}));
const capability: IndexSearchCapability = {
  coverage: vi.fn(),
  grep: vi.fn(),
  rebuild: vi.fn(),
  search: vi.fn(),
  status: vi.fn(),
};
const embeddingHostManager = { queryEmbedding: vi.fn() };
function entry(
  toolId: typeof NATIVE_TOOL_ID.queryEmbeddingSpace | typeof NATIVE_TOOL_ID.hybridSearch
) {
  const tool = SEARCH_TOOL_EXECUTORS[toolId]({
    dependencies: { embeddingHostManager, nativeIndexSearch: capability },
    isLocalProvider: false,
    readFileCursorRegistry: {} as never,
    resolveActiveDomainCharBudget: () => 6000,
    resolvedDomainCharBudget: 6000,
    runtimeData: undefined,
  });
  if (!tool) {
    throw new Error('Missing retrieval executor');
  }
  return tool as { execute: (input: unknown, context: unknown) => Promise<unknown> };
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
    expect(call?.[3]).toBe(signal);
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
      const signal = call?.[3] as AbortSignal;
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
