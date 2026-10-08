import {
  MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET,
  resolveScaledToolResultBudget,
} from '@brainstrike/agent';
import { decodedWorkspaceTextModelOutputChars as decodedChars } from '@brainstrike/host-capabilities/native-tools';
import { describe, expect, it } from 'vitest';
import { NativeQueryEmbeddingSpaceInputSchema } from '../../assistant-server/native-retrieval-schemas';
import {
  projectHybridSearchModelOutput,
  projectQueryEmbeddingSpaceModelOutput,
} from '../../assistant-server/workspace-retrieval-model-projections';

function serializedChars(value: unknown): number {
  return JSON.stringify(value).length;
}

function semanticResult() {
  return {
    budget: 4000,
    chunkContentIncludedInContext: true,
    chunks: [
      {
        chunkIndex: 4,
        fileName: 'assistant-tools.ts',
        filePath: '/apps/desktop/src/assistant-server/assistant-tools.ts',
        id: 'chunk-a',
        lineRange: { end: 120, start: 100 },
        metadata: {
          chunkType: 'code',
          embeddingSetId: 'workspace-index',
          fileRecordId: 'file-a',
          rank: 1,
          rootId: 'root-a',
          rootName: 'brainstrike',
        },
        offsets: { end: 4200, start: 3500 },
        rank: 1,
        score: 0.91,
        tokenCount: 120,
      },
    ],
    context:
      'Source 1: [brainstrike] /apps/desktop/src/assistant-server/assistant-tools.ts:100-120 (chunk 4)\nexport function buildDesktopAssistantTools() {}',
    embeddingSetId: 'workspace-index',
    limit: 20,
    query: 'where are assistant tools registered',
    remainingTokens: 3880,
    skipped: 0,
    skippedForMissingSourceRange: 0,
    skippedSourceRangeChunks: [],
    threshold: 0.3,
    totalTokens: 120,
  };
}

function hybridResult() {
  return {
    embeddingSetId: 'workspace-index',
    ftsWeight: 1,
    limit: 20,
    metadata: {
      ftsResultCount: 2,
      fusedResultCount: 2,
      totalMs: 18,
      vectorResultCount: 2,
    },
    query: 'assistant tool registry',
    results: [
      {
        chunkIndex: 4,
        content: 'export function buildDesktopAssistantTools() {}',
        fileName: 'assistant-tools.ts',
        filePath: '/apps/desktop/src/assistant-server/assistant-tools.ts',
        ftsRank: 4.2,
        id: 'chunk-a',
        position: 1,
        rootName: 'brainstrike',
        rrfScore: 0.032,
        sourceCount: 2,
        vectorSimilarity: 0.91,
      },
    ],
    root: 'brainstrike',
    truncated: false,
    vectorWeight: 1,
  };
}

describe('workspace retrieval model projections', () => {
  it('fits semantic context at floor, byte-identical anchor, and ceiling tiers', () => {
    const raw = {
      ...semanticResult(),
      context: 'semantic evidence '.repeat(2000),
    };
    const floorBudget = resolveScaledToolResultBudget(8192);
    const anchorBudget = resolveScaledToolResultBudget(131_072);
    const ceilingBudget = resolveScaledToolResultBudget(262_144);

    const floor = projectQueryEmbeddingSpaceModelOutput(
      raw,
      floorBudget.domainModelResultCharBudget
    );
    const anchor = projectQueryEmbeddingSpaceModelOutput(
      raw,
      anchorBudget.domainModelResultCharBudget
    );
    const defaultAnchor = projectQueryEmbeddingSpaceModelOutput(raw);
    const ceiling = projectQueryEmbeddingSpaceModelOutput(
      raw,
      ceilingBudget.domainModelResultCharBudget
    );

    expect(anchor).toEqual(defaultAnchor);
    expect(floor.value.length).toBeLessThan(anchor.value.length);
    expect(ceiling.value.length).toBeGreaterThan(anchor.value.length);
  });

  it('projects semantic evidence with ranked scores and exact source locations', () => {
    expect(projectQueryEmbeddingSpaceModelOutput(semanticResult())).toEqual({
      type: 'text',
      value: [
        'semantic | status=available | set=workspace-index | chunks=1 | tokens=120/4000 | remaining=3880 | skipped=0 | missing_ranges=0 | threshold=0.3',
        'scores: 1=0.91',
        'Source 1: [brainstrike] /apps/desktop/src/assistant-server/assistant-tools.ts:100-120 (chunk 4)',
        'export function buildDesktopAssistantTools() {}',
      ].join('\n'),
    });
  });

  it('self-fits oversized semantic evidence with explicit omission and refinement', () => {
    const raw = {
      ...semanticResult(),
      budget: 8000,
      chunks: Array.from({ length: 20 }, (_, index) => ({
        ...semanticResult().chunks[0],
        chunkIndex: index,
        id: `chunk-${index}`,
        rank: index + 1,
        score: 0.99 - index * 0.01,
        tokenCount: 300,
      })),
      context: Array.from(
        { length: 20 },
        (_, index) =>
          `Source ${index + 1}: [brainstrike] /src/domain-${index}.ts:${index * 20 + 1}-${index * 20 + 20} (chunk ${index})\n${'evidence '.repeat(170)}`
      ).join('\n\n---\n\n'),
      remainingTokens: 2000,
      totalTokens: 6000,
    };

    const projected = projectQueryEmbeddingSpaceModelOutput(raw);

    expect(serializedChars(raw)).toBeGreaterThan(MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET);
    // BST-1195 recalibrated this boundary to decoded model-visible text.
    expect(decodedChars([projected.value])).toBeLessThanOrEqual(
      MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET
    );
    expect(projected.value).toContain('projection_omitted_context_chars=');
    expect(projected.value).toContain(
      'refine: reuse brainstrike.queryEmbeddingSpace with a narrower query, root, maxChunks, or tokenBudget'
    );
  });

  it('offers only supported native refinements when semantic context is clipped', () => {
    const input = NativeQueryEmbeddingSpaceInputSchema.parse({ limit: 10, query: 'marker' });
    const projected = projectQueryEmbeddingSpaceModelOutput(
      { ...semanticResult(), ...input, context: 'native evidence '.repeat(500) },
      2000
    );

    expect(decodedChars([projected.value])).toBeLessThanOrEqual(2000);
    expect(projected.value).toContain('projection_omitted_context_chars=');
    expect(projected.value).toContain(
      'refine: reuse brainstrike.queryEmbeddingSpace with a narrower query, root, maxChunks, or tokenBudget'
    );
    expect(projected.value).not.toContain('filePaths');
    for (const refinement of [
      { query: 'narrower marker' },
      { root: 'brainstrike' },
      { maxChunks: 1 },
      { tokenBudget: 1000 },
    ]) {
      expect(
        NativeQueryEmbeddingSpaceInputSchema.safeParse({ ...input, ...refinement }).success
      ).toBe(true);
    }
  });

  it('projects unavailable workspace-index state without hiding the reason', () => {
    expect(
      projectQueryEmbeddingSpaceModelOutput({
        message: 'Workspace Index is blocked: missing-provider-key.',
        query: 'semantic lookup',
        reason: 'workspace-index-blocked',
        status: 'unavailable',
        workspaceIndex: {
          blockedReason: 'missing-provider-key',
          embeddingSetId: 'workspace-index',
          enabled: true,
          lastError: 'OpenAI key is required for Workspace Index.',
          paused: false,
          queueProgress: { failed: 0, pending: 2, processed: 3, totalQueued: 5 },
          statusState: 'blocked',
        },
      })
    ).toEqual({
      type: 'text',
      value: [
        'semantic | status=unavailable | reason=workspace-index-blocked | set=workspace-index | enabled=true | paused=false | index_state=blocked',
        'message: Workspace Index is blocked: missing-provider-key.',
        'blocked_reason: missing-provider-key',
        'last_error: OpenAI key is required for Workspace Index.',
        'queue: processed=3/5 | pending=2 | failed=0',
      ].join('\n'),
    });
  });

  it('projects hybrid evidence with fusion provenance and root-qualified paths', () => {
    expect(projectHybridSearchModelOutput(hybridResult())).toEqual({
      type: 'text',
      value: [
        'hybrid | set=workspace-index | shown=1/2 | root=brainstrike | truncated=false | vector=2 | fts=2 | fused=2 | weights=1:1 | total_ms=18',
        '#1 [brainstrike] /apps/desktop/src/assistant-server/assistant-tools.ts | chunk=4 | sources=2 | rrf=0.032 | vector=0.91 | fts=4.2 | id=chunk-a',
        'excerpt: export function buildDesktopAssistantTools() {}',
      ].join('\n'),
    });
  });

  it('preserves repeated whitespace in hybrid result paths', () => {
    const raw = hybridResult();
    raw.results[0]!.filePath = '/packages/path  with  spaces/file.ts';

    expect(projectHybridSearchModelOutput(raw).value).toContain(
      '[brainstrike] /packages/path  with  spaces/file.ts'
    );
  });

  it('escapes hybrid path line breaks without collapsing other path whitespace', () => {
    const raw = hybridResult();
    raw.results[0]!.filePath = '/packages/path  with\r\nline\u2028separator\u2029file.ts';

    expect(projectHybridSearchModelOutput(raw).value).toContain(
      String.raw`[brainstrike] /packages/path  with\r\nline\u2028separator\u2029file.ts`
    );
  });

  it('self-fits hybrid results and retains producer guidance when truncated', () => {
    const results = Array.from({ length: 20 }, (_, index) => ({
      ...hybridResult().results[0],
      content: `result ${index} ${'content '.repeat(130)}`,
      filePath: `/packages/${'nested/'.repeat(40)}domain-${index}.ts`,
      id: `chunk-${index}`,
      position: index + 1,
      rrfScore: 0.04 - index * 0.001,
    }));
    const raw = {
      ...hybridResult(),
      hint: 'Showing 20 of 50 fused results. Narrow with filePaths, chunkType, or a smaller limit.',
      metadata: { ...hybridResult().metadata, fusedResultCount: 50 },
      results,
      truncated: true,
    };

    const projected = projectHybridSearchModelOutput(raw);

    expect(decodedChars([projected.value])).toBeLessThanOrEqual(
      MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET
    );
    expect(projected.value).toContain('projection_omitted_results=');
    expect(projected.value).toContain(`hint: ${raw.hint}`);
  });

  it('throws visibly for malformed or unguided truncated results', () => {
    expect(() =>
      projectQueryEmbeddingSpaceModelOutput({
        ...semanticResult(),
        remainingTokens: 3900,
      })
    ).toThrow('queryEmbeddingSpace model projection received a malformed result');

    expect(() =>
      projectHybridSearchModelOutput({
        ...hybridResult(),
        metadata: { ...hybridResult().metadata, fusedResultCount: 2 },
        truncated: true,
      })
    ).toThrow('hybridSearch model projection received a malformed result');
  });
});
