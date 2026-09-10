import {
  createMcpAppToolInvocationResult,
  NATIVE_TOOL_ID,
  readMcpAppToolInvocationResult,
} from '@brainstrike/assistant-contract';
import {
  decodeToolOutputArtifactCursor,
  isToolOutputArtifactEnvelope,
  type ToolOutputArtifactReference,
} from '@brainstrike/assistant-contract/tool-output-artifact';
import type { ToolsInput } from '@mastra/core/agent';
import { RequestContext } from '@mastra/core/request-context';
import { describe, expect, it, vi } from 'vitest';
import { resolveEligibleArtifactReaderName } from '../mastra/runtime-assembly/tool-pipeline';
import {
  applyToolModelOutputProjections,
  wouldTruncateMcpModelOutput,
} from '../mastra/tool-model-output';
import {
  applyToolOutputArtifactSettlement,
  TOOL_OUTPUT_ARTIFACT_INLINE_MAX_BYTES,
  TOOL_OUTPUT_ARTIFACT_SETTLEMENT_MAX_BYTES,
  type ToolOutputArtifactSettlementError,
  type ToolOutputArtifactSettlementStore,
} from '../mastra/tool-output-artifact-settlement';
import { resolveScaledToolResultBudget } from '../stream/tool-output-limits';
import { applyToolHooks } from '../tools/hook-tool-wrap';

const ANCHOR_TOOL_RESULT_BUDGET = resolveScaledToolResultBudget(131_072);

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

function readOutputTransform(
  tool: ToolsInput[string],
  output: unknown,
  target: 'display' | 'transcript' = 'display'
): unknown {
  const transform = (
    tool as {
      transform?: {
        [key in 'display' | 'transcript']?: {
          output?: (context: {
            output: unknown;
            phase: 'output-available';
            target: 'display' | 'transcript';
            toolCallId: string;
            toolName: string;
          }) => unknown;
        };
      };
    }
  ).transform?.[target]?.output;
  if (!transform) {
    throw new TypeError('Fixture tool is missing its display output transform.');
  }
  return transform({
    output,
    phase: 'output-available',
    target,
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
  it('requires native child execution scope and never accepts it from tool input', async () => {
    const store = vi.fn<ToolOutputArtifactSettlementStore['store']>(async (input) =>
      reference(input.content.length)
    );
    const tools = applyToolOutputArtifactSettlement(
      { fixture: executableTool(async () => 'x'.repeat(12_500)) },
      {
        getReaderToolName: () => NATIVE_TOOL_ID.readToolOutputArtifact,
        requireExecutionThreadId: true,
        store: settlementStore(store),
        toolNameMap: new Map(),
      }
    );
    const execute = (tools['fixture'] as { execute: (...args: unknown[]) => Promise<unknown> })
      .execute;
    await expect(
      execute(
        { executionThreadId: 'forged', threadId: 'forged' },
        { agent: { toolCallId: 'call' } }
      )
    ).rejects.toMatchObject({ reason: 'missing_execution_thread_id' });
    expect(store).not.toHaveBeenCalled();
    await execute(
      { executionThreadId: 'forged' },
      { agent: { threadId: 'native-child', toolCallId: 'call' } }
    );
    expect(store).toHaveBeenCalledWith(
      expect.objectContaining({ executionThreadId: 'native-child', toolCallId: 'call' })
    );
    const requestContext = new RequestContext();
    requestContext.set('MastraMemory', { resourceId: 'owner', thread: { id: 'native-sdk-child' } });
    await execute({}, { requestContext, toolCallId: 'sdk-call' });
    expect(store).toHaveBeenLastCalledWith(
      expect.objectContaining({ executionThreadId: 'native-sdk-child', toolCallId: 'sdk-call' })
    );
  });

  it.each([0, 2])('rejects %i eligible readers before writing any artifact', async (count) => {
    const readerIds = Array.from({ length: count }, (_, index) => `reader-${index}`);
    const readers = Object.fromEntries(
      readerIds.map((id) => [id, executableTool(async () => ({}))])
    );
    const names = new Map(readerIds.map((id) => [id, NATIVE_TOOL_ID.readToolOutputArtifact]));
    const store = vi.fn<ToolOutputArtifactSettlementStore['store']>();
    const tools = applyToolOutputArtifactSettlement(
      { fixture: executableTool(async () => 'x'.repeat(12_500)) },
      {
        getReaderToolName: () => resolveEligibleArtifactReaderName(readers, names),
        store: settlementStore(store),
        toolNameMap: new Map(),
      }
    );
    await expect(
      (tools['fixture'] as { execute: (...args: unknown[]) => Promise<unknown> }).execute(
        {},
        { agent: { toolCallId: 'call-1' } }
      )
    ).rejects.toThrow('one eligible artifact reader');
    expect(store).not.toHaveBeenCalled();
  });

  it.each([7900, 9042, 11_900, 12_500])(
    'preserves every byte of a %i-character MCP result inline or in storage',
    async (length) => {
      const output =
        `${'x'.repeat(Math.floor(length / 2))}required-middle-criterion${'y'.repeat(length)}`.slice(
          0,
          length
        );
      const store = vi.fn<ToolOutputArtifactSettlementStore['store']>(async (input) => ({
        ...reference(new TextEncoder().encode(input.content).byteLength),
        format: input.format,
      }));
      const tools = applyToolOutputArtifactSettlement(
        { fixture: executableTool(async () => output) },
        {
          getReaderToolName: () => 'registered_reader',
          store: settlementStore(store),
          toolNameMap: new Map(),
          wouldTruncateModelOutput: (name, value) =>
            wouldTruncateMcpModelOutput(name, value, ANCHOR_TOOL_RESULT_BUDGET),
        }
      );
      const projected = applyToolModelOutputProjections(
        tools,
        new Map(),
        undefined,
        ANCHOR_TOOL_RESULT_BUDGET
      );
      const tool = projected['fixture'] as {
        execute: (...args: unknown[]) => Promise<unknown>;
        toModelOutput: (output: unknown) => unknown;
      };
      const modelOutput = tool.toModelOutput(
        await tool.execute({}, { agent: { toolCallId: 'call-1' } })
      );
      if (length === 7900) {
        expect(modelOutput).toEqual({ type: 'text', value: output });
        expect(store).not.toHaveBeenCalled();
        return;
      }
      expect(store).toHaveBeenCalledExactlyOnceWith({
        content: output,
        format: 'text',
        toolCallId: 'call-1',
      });
      expect(modelOutput).toMatchObject({
        type: 'json',
        value: { next: { tool: 'registered_reader' } },
      });
      expect(JSON.stringify(modelOutput)).not.toContain('tool_result_truncated');
    }
  );

  it('surfaces storage failure for an MCP result that only exceeds the model budget', async () => {
    const tools = applyToolOutputArtifactSettlement(
      { fixture: executableTool(async () => 'x'.repeat(9042)) },
      {
        getReaderToolName: () => NATIVE_TOOL_ID.readToolOutputArtifact,
        store: settlementStore(async () => {
          throw new Error('storage offline');
        }),
        toolNameMap: new Map(),
        wouldTruncateModelOutput: (name, value) =>
          wouldTruncateMcpModelOutput(name, value, ANCHOR_TOOL_RESULT_BUDGET),
      }
    );
    await expect(
      (tools['fixture'] as { execute: (...args: unknown[]) => Promise<unknown> }).execute(
        {},
        { agent: { toolCallId: 'call-1' } }
      )
    ).rejects.toMatchObject({ reason: 'store_failed' });
  });

  it('keeps an inline result byte-exact and does not touch storage when it fits', async () => {
    const output = { evidence: 'small' };
    const store = vi.fn<ToolOutputArtifactSettlementStore['store']>();
    const tools = applyToolOutputArtifactSettlement(
      { fixture: executableTool(async () => output) },
      {
        getReaderToolName: () => NATIVE_TOOL_ID.readToolOutputArtifact,
        store: settlementStore(store),
        toolNameMap: new Map(),
      }
    );

    const result = await (
      tools['fixture'] as { execute: (...args: unknown[]) => Promise<unknown> }
    ).execute({}, { agent: { toolCallId: 'call-1' } });

    expect(result).toBe(output);
    expect(store).not.toHaveBeenCalled();
  });

  it.each([0, 16, 9042, 12_500])(
    'preserves an MCP Apps marker and ordinary recovery through hooks at %i chars',
    async (length) => {
      const marker = createMcpAppToolInvocationResult(
        {
          mimeType: 'text/html;profile=mcp-app',
          resourceUri: 'ui://issues/detail',
          serverId: 'remote',
          toolName: 'show_issue',
        },
        length === 0 ? null : { description: 'x'.repeat(length), issueId: 'BST-1572' }
      );
      const store = vi.fn<ToolOutputArtifactSettlementStore['store']>(async (input) => ({
        ...reference(new TextEncoder().encode(input.content).byteLength),
        format: input.format,
      }));
      const hooked = applyToolHooks(
        { fixture: executableTool(async () => marker) },
        {
          hookRunner: {
            postToolUse: vi.fn(async () => ({ additionalContext: 'inspect the issue details' })),
            preToolUse: vi.fn(async () => ({ decision: 'allow' as const })),
          },
          toolNameMap: new Map(),
        }
      );
      const settled = applyToolOutputArtifactSettlement(hooked as ToolsInput, {
        getReaderToolName: () => 'registered_reader',
        store: settlementStore(store),
        toolNameMap: new Map(),
        wouldTruncateModelOutput: (name, value) =>
          wouldTruncateMcpModelOutput(name, value, ANCHOR_TOOL_RESULT_BUDGET),
      });
      const projected = applyToolModelOutputProjections(
        settled,
        new Map(),
        undefined,
        ANCHOR_TOOL_RESULT_BUDGET
      );
      const tool = projected['fixture'] as {
        execute: (...args: unknown[]) => Promise<unknown>;
        toModelOutput: (output: unknown) => unknown;
      };

      const result = await tool.execute({}, { agent: { toolCallId: 'call-1' } });
      const display = readOutputTransform(tool, result);
      const model = tool.toModelOutput(result);

      expect(readMcpAppToolInvocationResult(display)).toEqual(marker);
      expect(
        readMcpAppToolInvocationResult(readOutputTransform(tool, result, 'transcript'))
      ).toEqual(marker);
      if (length > 8000) {
        expect(store).toHaveBeenCalledExactlyOnceWith({
          content: JSON.stringify(marker.result),
          format: 'json',
          toolCallId: 'call-1',
        });
        expect(JSON.stringify(model)).toContain('registered_reader');
      } else {
        expect(store).not.toHaveBeenCalled();
      }
      if (length <= 16) {
        expect(JSON.stringify(model)).toContain(length === 0 ? 'null' : 'BST-1572');
      }
      expect(JSON.stringify(model)).toContain('Post-tool context: inspect the issue details');
      expect(JSON.stringify(model)).not.toContain('mcp-app');
    }
  );

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
        getReaderToolName: () => NATIVE_TOOL_ID.readToolOutputArtifact,
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

  it('does not publish an EOF cursor when a character-threshold artifact fits one page', async () => {
    const output = { payload: 'x'.repeat(3000) };
    const serialized = JSON.stringify(output);
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThan(
      TOOL_OUTPUT_ARTIFACT_INLINE_MAX_BYTES
    );
    const store = vi.fn<ToolOutputArtifactSettlementStore['store']>(async (input) => ({
      ...reference(new TextEncoder().encode(input.content).byteLength),
      format: 'json',
    }));
    const settled = applyToolOutputArtifactSettlement(
      { fixture: executableTool(async () => output) },
      {
        getReaderToolName: () => NATIVE_TOOL_ID.readToolOutputArtifact,
        inlineMaxSerializedCharsByToolName: new Map([['brainstrike.webExtract', 1000]]),
        store: settlementStore(store),
        toolNameMap: new Map([['fixture', 'brainstrike.webExtract']]),
      }
    );
    const projected = applyToolModelOutputProjections(
      settled,
      new Map([['fixture', 'brainstrike.webExtract']]),
      undefined,
      ANCHOR_TOOL_RESULT_BUDGET
    );
    const tool = projected['fixture'] as {
      execute: (...args: unknown[]) => Promise<unknown>;
      toModelOutput: (output: unknown) => unknown;
    };

    const result = await tool.execute({}, { agent: { toolCallId: 'call-1' } });
    const display = readOutputTransform(tool, result);
    const model = tool.toModelOutput(result);

    expect(store).toHaveBeenCalledOnce();
    expect(display).toEqual(output);
    expect(isToolOutputArtifactEnvelope(display)).toBe(false);
    expect(model).toMatchObject({
      type: 'json',
      value: {
        complete: true,
        endByte: new TextEncoder().encode(serialized).byteLength,
        offsetByte: 0,
      },
    });
    expect(JSON.stringify(model)).not.toContain('nextCursor');
    expect(JSON.stringify(model)).not.toContain('readToolOutputArtifact');
  });

  it('durably stores a complete oversized result before publishing a bounded envelope', async () => {
    const output = `head-${'x'.repeat(TOOL_OUTPUT_ARTIFACT_INLINE_MAX_BYTES)}-tail`;
    const store = vi.fn<ToolOutputArtifactSettlementStore['store']>(async (input) =>
      reference(new TextEncoder().encode(input.content).byteLength)
    );
    const settled = applyToolOutputArtifactSettlement(
      { fixture: executableTool(async () => output) },
      {
        getReaderToolName: () => NATIVE_TOOL_ID.readToolOutputArtifact,
        store: settlementStore(store),
        toolNameMap: new Map([['fixture', 'workspace.read']]),
      }
    );
    const projected = applyToolModelOutputProjections(
      settled,
      new Map([['fixture', 'workspace.read']]),
      undefined,
      ANCHOR_TOOL_RESULT_BUDGET
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
      hint: 'The complete workspace.read result is durable. Search with pattern or continue paging via brainstrike.readToolOutputArtifact using {"cursor":nextCursor}.',
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

  it('mentions delegation only when a delegation tool is registered for the run', async () => {
    const output = `head-${'x'.repeat(TOOL_OUTPUT_ARTIFACT_INLINE_MAX_BYTES)}-tail`;
    const store = settlementStore(async (input) => reference(input.content.length));

    const executeWithDelegationTools = async (
      getDelegationToolNames: () => readonly string[]
    ): Promise<string> => {
      const tools = applyToolOutputArtifactSettlement(
        { fixture: executableTool(async () => output) },
        {
          getDelegationToolNames,
          getReaderToolName: () => NATIVE_TOOL_ID.readToolOutputArtifact,
          store,
          toolNameMap: new Map([['fixture', 'workspace.read']]),
        }
      );
      const result = await (
        tools['fixture'] as { execute: (...args: unknown[]) => Promise<unknown> }
      ).execute({}, { agent: { toolCallId: 'call-1' } });
      const display = readOutputTransform(tools['fixture'], result);
      if (!isToolOutputArtifactEnvelope(display)) {
        throw new TypeError('Expected a valid artifact envelope.');
      }
      return display.hint;
    };

    const registered = await executeWithDelegationTools(() => ['agent-analyze']);
    expect(registered).toContain('Search with pattern');
    expect(registered).toContain('delegate the cursor to agent-analyze');

    const unavailable = await executeWithDelegationTools(() => []);
    expect(unavailable).toContain('Search with pattern');
    expect(unavailable).not.toContain('delegate');
    expect(unavailable).not.toContain('agent-analyze');
  });

  it.each(['brainstrike.inspectCommandSessions', 'brainstrike.manageCommandSession'])(
    'never durably settles command-session output from %s',
    async (toolName) => {
      const output = {
        output: `secret-${'x'.repeat(TOOL_OUTPUT_ARTIFACT_INLINE_MAX_BYTES)}`,
      };
      const store = vi.fn<ToolOutputArtifactSettlementStore['store']>(async (input) => ({
        ...reference(new TextEncoder().encode(input.content).byteLength),
        format: 'json',
      }));
      const tools = applyToolOutputArtifactSettlement(
        { fixture: executableTool(async () => output) },
        {
          getReaderToolName: () => NATIVE_TOOL_ID.readToolOutputArtifact,
          store: settlementStore(store),
          toolNameMap: new Map([['fixture', toolName]]),
        }
      );

      const result = await (
        tools['fixture'] as { execute: (...args: unknown[]) => Promise<unknown> }
      ).execute({}, { agent: { toolCallId: 'call-1' } });

      expect(result).toBe(output);
      expect(store).not.toHaveBeenCalled();
    }
  );

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
      {
        getReaderToolName: () => NATIVE_TOOL_ID.readToolOutputArtifact,
        store: settlementStore(store),
        toolNameMap: new Map(),
      }
    );
    const projected = applyToolModelOutputProjections(
      settled,
      new Map(),
      undefined,
      ANCHOR_TOOL_RESULT_BUDGET
    );
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

  it.each([false, true])('preserves oversized MCP media inline (Apps: %s)', async (isApp) => {
    const ordinary = {
      content: [
        { text: 'A rendered image.', type: 'text' },
        {
          data: 'a'.repeat(TOOL_OUTPUT_ARTIFACT_INLINE_MAX_BYTES),
          mimeType: 'image/png',
          type: 'image',
        },
      ],
    };
    const output = isApp
      ? createMcpAppToolInvocationResult(
          {
            mimeType: 'text/html;profile=mcp-app',
            resourceUri: 'ui://image/detail',
            serverId: 'remote',
            toolName: 'show_image',
          },
          ordinary
        )
      : ordinary;
    const store = vi.fn<ToolOutputArtifactSettlementStore['store']>();
    const tools = applyToolOutputArtifactSettlement(
      { fixture: executableTool(async () => output) },
      {
        getReaderToolName: () => NATIVE_TOOL_ID.readToolOutputArtifact,
        store: settlementStore(store),
        toolNameMap: new Map(),
      }
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
      getReaderToolName: () => NATIVE_TOOL_ID.readToolOutputArtifact,
      store: settlementStore(async (input) => reference(input.content.length)),
      toolNameMap: new Map(),
    });
    const projected = applyToolModelOutputProjections(
      settled,
      new Map(),
      undefined,
      ANCHOR_TOOL_RESULT_BUDGET
    );
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
        getReaderToolName: () => NATIVE_TOOL_ID.readToolOutputArtifact,
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
        getReaderToolName: () => NATIVE_TOOL_ID.readToolOutputArtifact,
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
        getReaderToolName: () => NATIVE_TOOL_ID.readToolOutputArtifact,
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
      {
        getReaderToolName: () => NATIVE_TOOL_ID.readToolOutputArtifact,
        store: settlementStore(store),
        toolNameMap: new Map(),
      }
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
