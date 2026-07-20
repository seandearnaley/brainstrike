import {
  decodeToolOutputArtifactCursor,
  isToolOutputArtifactEnvelope,
  type ToolOutputArtifactReference,
} from '@brainstrike/assistant-contract/tool-output-artifact';
import type { ToolsInput } from '@mastra/core/agent';
import { describe, expect, it, vi } from 'vitest';
import { applyToolModelOutputProjections } from '../mastra/tool-model-output';
import {
  applyToolOutputArtifactSettlement,
  TOOL_OUTPUT_ARTIFACT_INLINE_MAX_BYTES,
  TOOL_OUTPUT_ARTIFACT_SETTLEMENT_MAX_BYTES,
  type ToolOutputArtifactSettlementError,
  type ToolOutputArtifactSettlementStore,
} from '../mastra/tool-output-artifact-settlement';
import { applyToolHooks } from '../tools/hook-tool-wrap';

const reference = (byteLength: number): ToolOutputArtifactReference => ({
  byteLength,
  expiresAt: '2026-07-27T12:00:00.000Z',
  format: 'text',
  id: '019f7d67-7165-7c23-8e99-d70c2a2f168d',
});

function executableTool(
  execute: (...args: unknown[]) => unknown,
  toModelOutput?: (output: unknown) => unknown
): ToolsInput[string] {
  return {
    description: 'fixture',
    execute,
    id: 'fixture',
    inputSchema: { jsonSchema: { additionalProperties: false, type: 'object' } },
    ...(toModelOutput ? { toModelOutput } : {}),
  } as ToolsInput[string];
}

function readOutputTransform(tool: ToolsInput[string], output: unknown): unknown {
  const transform = (
    tool as {
      transform?: {
        display?: {
          output?: (context: {
            output: unknown;
            phase: 'output-available';
            target: 'display';
            toolCallId: string;
            toolName: string;
          }) => unknown;
        };
      };
    }
  ).transform?.display?.output;
  if (!transform) {
    throw new TypeError('Fixture tool is missing its display output transform.');
  }
  return transform({
    output,
    phase: 'output-available',
    target: 'display',
    toolCallId: 'call-1',
    toolName: 'fixture',
  });
}

function settlementStore(
  store: ToolOutputArtifactSettlementStore['store']
): ToolOutputArtifactSettlementStore {
  return { store };
}

describe('tool output artifact settlement', () => {
  it('keeps an inline result byte-exact and does not touch storage when it fits', async () => {
    const output = { evidence: 'small' };
    const store = vi.fn<ToolOutputArtifactSettlementStore['store']>();
    const tools = applyToolOutputArtifactSettlement(
      { fixture: executableTool(async () => output) },
      { store: settlementStore(store), toolNameMap: new Map() }
    );

    const result = await (
      tools['fixture'] as { execute: (...args: unknown[]) => Promise<unknown> }
    ).execute({}, { agent: { toolCallId: 'call-1' } });

    expect(result).toBe(output);
    expect(store).not.toHaveBeenCalled();
  });

  it('settles a tool above its stricter serialized-character threshold', async () => {
    const output = { payload: '雪\\n"quoted" 😀'.repeat(400) };
    const serialized = JSON.stringify(output);
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThan(
      TOOL_OUTPUT_ARTIFACT_INLINE_MAX_BYTES
    );
    const store = vi.fn<ToolOutputArtifactSettlementStore['store']>(async (input) => ({
      ...reference(new TextEncoder().encode(input.content).byteLength),
      format: 'json',
    }));
    const tools = applyToolOutputArtifactSettlement(
      { fixture: executableTool(async () => output) },
      {
        inlineMaxSerializedCharsByToolName: new Map([['brainstrike.webExtract', 1000]]),
        store: settlementStore(store),
        toolNameMap: new Map([['fixture', 'brainstrike.webExtract']]),
      }
    );

    const result = await (
      tools['fixture'] as { execute: (...args: unknown[]) => Promise<unknown> }
    ).execute({}, { agent: { toolCallId: 'call-1' } });

    expect(store).toHaveBeenCalledWith({
      content: serialized,
      format: 'json',
      toolCallId: 'call-1',
    });
    expect(isToolOutputArtifactEnvelope(readOutputTransform(tools['fixture'], result))).toBe(true);
  });

  it('durably stores a complete oversized result before publishing a bounded envelope', async () => {
    const output = `head-${'x'.repeat(TOOL_OUTPUT_ARTIFACT_INLINE_MAX_BYTES)}-tail`;
    const store = vi.fn<ToolOutputArtifactSettlementStore['store']>(async (input) =>
      reference(new TextEncoder().encode(input.content).byteLength)
    );
    const settled = applyToolOutputArtifactSettlement(
      { fixture: executableTool(async () => output) },
      { store: settlementStore(store), toolNameMap: new Map([['fixture', 'workspace.read']]) }
    );
    const projected = applyToolModelOutputProjections(
      settled,
      new Map([['fixture', 'workspace.read']])
    );
    const tool = projected['fixture'] as {
      execute: (...args: unknown[]) => Promise<unknown>;
      toModelOutput: (output: unknown) => unknown;
    };

    const result = await tool.execute({}, { agent: { toolCallId: 'call-1' } });
    const display = readOutputTransform(tool, result);
    const model = tool.toModelOutput(result);

    expect(store).toHaveBeenCalledOnce();
    expect(store).toHaveBeenCalledWith({
      content: output,
      format: 'text',
      toolCallId: 'call-1',
    });
    expect(isToolOutputArtifactEnvelope(display)).toBe(true);
    if (!isToolOutputArtifactEnvelope(display)) {
      throw new TypeError('Expected a valid artifact envelope.');
    }
    expect(decodeToolOutputArtifactCursor(display.nextCursor)).toEqual({
      artifactRef: display.artifactRef,
      offsetByte: new TextEncoder().encode(display.preview).byteLength,
    });
    expect(display).toMatchObject({
      artifactRef: { byteLength: new TextEncoder().encode(output).byteLength },
      code: 'tool_output_artifact',
      hint: 'The complete workspace.read result is durable. Continue with brainstrike.readToolOutputArtifact using {"cursor":nextCursor}.',
      truncated: true,
      version: 1,
    });
    expect(JSON.stringify(display).length).toBeLessThanOrEqual(9000);
    expect(model).toMatchObject({ type: 'json' });
    expect(JSON.stringify(model)).toContain('brainstrike.readToolOutputArtifact');
    expect(JSON.stringify(model)).toContain('"cursor":"bsto1.');
    expect(JSON.stringify(model)).not.toContain('artifactRef');
    expect(JSON.stringify(model)).not.toContain('output was truncated');
    expect(JSON.stringify(model).length).toBeLessThanOrEqual(8000);
  });

  it('bypasses a custom projector after settlement so the model receives the artifact cursor', async () => {
    const output = { payload: 'x'.repeat(TOOL_OUTPUT_ARTIFACT_INLINE_MAX_BYTES), tail: 'kept' };
    const projector = vi.fn((value: unknown) => ({
      type: 'text',
      value: (value as typeof output).tail,
    }));
    const store = vi.fn<ToolOutputArtifactSettlementStore['store']>(async (input) => ({
      ...reference(new TextEncoder().encode(input.content).byteLength),
      format: 'json',
    }));
    const settled = applyToolOutputArtifactSettlement(
      { fixture: executableTool(async () => output, projector) },
      { store: settlementStore(store), toolNameMap: new Map() }
    );
    const projected = applyToolModelOutputProjections(settled, new Map());
    const tool = projected['fixture'] as {
      execute: (...args: unknown[]) => Promise<unknown>;
      toModelOutput: (output: unknown) => unknown;
    };

    const result = await tool.execute({}, { agent: { toolCallId: 'call-1' } });

    const display = readOutputTransform(tool, result);
    const model = tool.toModelOutput(result);

    expect(projector).not.toHaveBeenCalled();
    expect(isToolOutputArtifactEnvelope(display)).toBe(true);
    expect(JSON.stringify(model)).toContain('brainstrike.readToolOutputArtifact');
    expect(JSON.stringify(model)).toContain('"cursor":"bsto1.');
    expect(JSON.stringify(model)).not.toContain('kept');
  });

  it('preserves oversized MCP media inline instead of settling it as text', async () => {
    const output = {
      content: [
        { text: 'A rendered image.', type: 'text' },
        {
          data: 'a'.repeat(TOOL_OUTPUT_ARTIFACT_INLINE_MAX_BYTES),
          mimeType: 'image/png',
          type: 'image',
        },
      ],
    };
    const store = vi.fn<ToolOutputArtifactSettlementStore['store']>();
    const tools = applyToolOutputArtifactSettlement(
      { fixture: executableTool(async () => output) },
      { store: settlementStore(store), toolNameMap: new Map() }
    );
    const tool = tools['fixture'] as {
      execute: (...args: unknown[]) => Promise<unknown>;
    };

    const result = await tool.execute({}, { agent: { toolCallId: 'call-1' } });

    expect(result).toBe(output);
    expect(readOutputTransform(tool, result)).toBe(output);
    expect(store).not.toHaveBeenCalled();
  });

  it('preserves authenticated PostToolUse context while displaying only the artifact envelope', async () => {
    const output = `head-${'x'.repeat(TOOL_OUTPUT_ARTIFACT_INLINE_MAX_BYTES)}-tail`;
    const hooked = applyToolHooks(
      { fixture: executableTool(async () => output) },
      {
        hookRunner: {
          postToolUse: vi.fn(async () => ({ additionalContext: 'verify the durable tail' })),
          preToolUse: vi.fn(async () => ({ decision: 'allow' as const })),
        },
        toolNameMap: new Map(),
      }
    );
    const settled = applyToolOutputArtifactSettlement(hooked as ToolsInput, {
      store: settlementStore(async (input) => reference(input.content.length)),
      toolNameMap: new Map(),
    });
    const projected = applyToolModelOutputProjections(settled, new Map());
    const tool = projected['fixture'] as {
      execute: (...args: unknown[]) => Promise<unknown>;
      toModelOutput: (output: unknown) => unknown;
    };

    const result = await tool.execute({}, { agent: { toolCallId: 'call-1' } });
    const model = tool.toModelOutput(result);

    expect(readOutputTransform(tool, result)).toMatchObject({
      code: 'tool_output_artifact',
      truncated: true,
    });
    expect(JSON.stringify(model)).toContain('brainstrike.readToolOutputArtifact');
    expect(JSON.stringify(model)).toContain('Post-tool context: verify the durable tail');
  });

  it('fails visibly without publishing an envelope when durable storage fails', async () => {
    const storeError = new Error('database unavailable');
    const tools = applyToolOutputArtifactSettlement(
      {
        fixture: executableTool(async () => 'x'.repeat(TOOL_OUTPUT_ARTIFACT_INLINE_MAX_BYTES + 1)),
      },
      {
        store: settlementStore(async () => {
          throw storeError;
        }),
        toolNameMap: new Map(),
      }
    );

    await expect(
      (tools['fixture'] as { execute: (...args: unknown[]) => Promise<unknown> }).execute(
        {},
        { agent: { toolCallId: 'call-1' } }
      )
    ).rejects.toMatchObject({
      cause: storeError,
      name: 'ToolOutputArtifactSettlementError',
      reason: 'store_failed',
    });
  });

  it('fails visibly when storage returns an invalid artifact reference', async () => {
    const tools = applyToolOutputArtifactSettlement(
      {
        fixture: executableTool(async () => 'x'.repeat(TOOL_OUTPUT_ARTIFACT_INLINE_MAX_BYTES + 1)),
      },
      {
        store: settlementStore(async (input) => ({
          ...reference(input.content.length),
          id: '/tmp/untrusted-artifact.txt',
        })),
        toolNameMap: new Map(),
      }
    );

    await expect(
      (tools['fixture'] as { execute: (...args: unknown[]) => Promise<unknown> }).execute(
        {},
        { agent: { toolCallId: 'call-1' } }
      )
    ).rejects.toMatchObject({
      name: 'ToolOutputArtifactSettlementError',
      reason: 'store_failed',
    });
  });

  it('fails visibly when an oversized result has no trustworthy tool-call id', async () => {
    const tools = applyToolOutputArtifactSettlement(
      {
        fixture: executableTool(async () => 'x'.repeat(TOOL_OUTPUT_ARTIFACT_INLINE_MAX_BYTES + 1)),
      },
      {
        store: settlementStore(async (input) => reference(input.content.length)),
        toolNameMap: new Map(),
      }
    );

    await expect(
      (tools['fixture'] as { execute: (...args: unknown[]) => Promise<unknown> }).execute({})
    ).rejects.toEqual(
      expect.objectContaining<ToolOutputArtifactSettlementError>({
        name: 'ToolOutputArtifactSettlementError',
        reason: 'missing_tool_call_id',
      })
    );
  });

  it('rejects outputs above the explicit settlement cap before calling storage', async () => {
    const store = vi.fn<ToolOutputArtifactSettlementStore['store']>();
    const tools = applyToolOutputArtifactSettlement(
      {
        fixture: executableTool(async () =>
          'x'.repeat(TOOL_OUTPUT_ARTIFACT_SETTLEMENT_MAX_BYTES + 1)
        ),
      },
      { store: settlementStore(store), toolNameMap: new Map() }
    );

    await expect(
      (tools['fixture'] as { execute: (...args: unknown[]) => Promise<unknown> }).execute(
        {},
        { toolCallId: 'call-1' }
      )
    ).rejects.toMatchObject({
      name: 'ToolOutputArtifactSettlementError',
      reason: 'output_too_large',
    });
    expect(store).not.toHaveBeenCalled();
  });
});
