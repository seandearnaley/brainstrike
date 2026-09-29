import {
  applyToolModelOutputProjections,
  decodedTextModelOutputChars,
  NATIVE_TOOL_ID,
  type RuntimeData,
  resolveScaledToolResultBudget,
  type ScaledToolResultBudget,
} from '@brainstrike/agent';
import { describe, expect, it, vi } from 'vitest';
import { buildDesktopAssistantTools } from '../../assistant-server/assistant-tools';

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
}));

vi.mock('../../db-main', () => ({
  getDatabase: vi.fn(),
}));

type ProjectionTools = Parameters<typeof applyToolModelOutputProjections>[0];
type ProjectableTool = ProjectionTools[string] & {
  toModelOutput?: (output: unknown) => unknown;
};

function requireProjection(tool: ProjectableTool | undefined): (output: unknown) => unknown {
  if (!tool || typeof tool.toModelOutput !== 'function') {
    throw new TypeError('Expected a projectable desktop tool');
  }
  return (output: unknown) => tool.toModelOutput?.call(tool, output);
}

function projectWithBudget(
  toolId: string,
  tool: ProjectableTool,
  budget: ScaledToolResultBudget,
  output: unknown
): unknown {
  const projectedTools = applyToolModelOutputProjections(
    { [toolId]: tool } as ProjectionTools,
    new Map([[toolId, toolId]]),
    undefined,
    budget
  );
  return requireProjection(projectedTools[toolId])(output);
}

function textProjection(value: unknown): { type: 'text'; value: string } {
  if (
    !value ||
    typeof value !== 'object' ||
    (value as { type?: unknown }).type !== 'text' ||
    typeof (value as { value?: unknown }).value !== 'string'
  ) {
    throw new TypeError('Expected a text projection');
  }
  return value as { type: 'text'; value: string };
}

describe('desktop projector per-call budget context', () => {
  it('narrows and widens the same grep tool for different active run budgets', () => {
    const anchorBudget = resolveScaledToolResultBudget(131_072);
    const floorBudget = resolveScaledToolResultBudget(8192);
    const ceilingBudget = resolveScaledToolResultBudget(1_050_000);
    const tools = buildDesktopAssistantTools({ provider: 'openrouter' } as RuntimeData, {
      resolvedToolResultBudget: anchorBudget,
    });
    const grepTool = tools[NATIVE_TOOL_ID.grepSearch] as ProjectableTool | undefined;
    if (!grepTool) {
      throw new TypeError('Expected grepSearch desktop tool');
    }
    const matches = Array.from({ length: 500 }, (_, index) => ({
      after: [],
      before: [],
      line: index + 1,
      lineText: `match-${index}-${'x'.repeat(80)}`,
      path: '/src/tiered.ts',
      rootId: 'root-a',
      rootName: 'alpha',
      source: 'both' as const,
    }));
    const raw = {
      candidatesTruncated: false,
      liveEngine: 'ripgrep',
      matches,
      offset: 0,
      outputMode: 'content',
      scanLimited: false,
      skippedMissingLineMetadata: 0,
      totalMatches: matches.length,
      truncated: false,
    };

    const parent = textProjection(requireProjection(grepTool)(raw));
    const floor = textProjection(
      projectWithBudget(NATIVE_TOOL_ID.grepSearch, grepTool, floorBudget, raw)
    );
    const ceiling = textProjection(
      projectWithBudget(NATIVE_TOOL_ID.grepSearch, grepTool, ceilingBudget, raw)
    );

    expect(decodedTextModelOutputChars(floor.value)).toBeLessThanOrEqual(
      floorBudget.domainModelResultCharBudget
    );
    expect(parent.value.length).toBeGreaterThan(floor.value.length);
    expect(ceiling.value.length).toBeGreaterThan(parent.value.length);
  });

  it('fits readToolOutputArtifact to an active floor budget and preserves anchor bytes', () => {
    const anchorBudget = resolveScaledToolResultBudget(131_072);
    const floorBudget = resolveScaledToolResultBudget(8192);
    const tools = buildDesktopAssistantTools({ provider: 'openrouter' } as RuntimeData, {
      resolvedToolResultBudget: anchorBudget,
      toolOutputArtifactReader: {
        readRange: async () => ({ status: 'not_found' }),
      },
    });
    const artifactTool = tools[NATIVE_TOOL_ID.readToolOutputArtifact] as
      | ProjectableTool
      | undefined;
    if (!artifactTool) {
      throw new TypeError('Expected readToolOutputArtifact desktop tool');
    }
    const content = 'x'.repeat(5800);
    const raw = {
      artifactRef: {
        byteLength: content.length,
        expiresAt: '2026-08-16T12:00:00.000Z',
        format: 'text' as const,
        id: '019f7d67-7165-7c23-8e99-d70c2a2f168d',
      },
      content,
      endByte: content.length,
      offsetByte: 0,
    };

    const parent = requireProjection(artifactTool)(raw);
    const anchor = projectWithBudget(
      NATIVE_TOOL_ID.readToolOutputArtifact,
      artifactTool,
      anchorBudget,
      raw
    );
    const floor = projectWithBudget(
      NATIVE_TOOL_ID.readToolOutputArtifact,
      artifactTool,
      floorBudget,
      raw
    );

    expect(anchor).toEqual(parent);
    expect(JSON.stringify(floor).length).toBeLessThanOrEqual(
      floorBudget.domainModelResultCharBudget
    );
    const renamed = { ...artifactTool, id: 'brainstrike_readToolOutputArtifact_collision' };
    const projected = applyToolModelOutputProjections(
      { [renamed.id]: renamed },
      new Map([[renamed.id, NATIVE_TOOL_ID.readToolOutputArtifact]]),
      undefined,
      floorBudget
    );
    expect(requireProjection(projected[renamed.id])(raw)).toMatchObject({
      value: { next: { tool: renamed.id } },
    });
  });
});
