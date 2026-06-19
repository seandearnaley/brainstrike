/**
 * Server-side permission-policy WIRE assembly (PR-1.4a).
 *
 * Two layers are proven here:
 *
 * 1. `resolveRequestPermissionPolicy` (pure): the renderer-carried opt-in
 *    snapshot → trusted `PermissionToolGateSnapshot`. `enforce:false`/absent →
 *    `undefined` (passthrough); `enforce:true` → a snapshot with SERVER-built
 *    `riskByTool` (`buildNativeToolRiskMap`) + `defaultRisk: 'mcp'`.
 *
 * 2. END-TO-END through the REAL Mastra agent loop (no agent mocks — only the
 *    language model is a scripted fake): a runtime whose `permissionPolicy` is
 *    the resolver output for an `edit:'deny'` + `enforce:true` request OMITS the
 *    two edit-risk native tools, while an `enforce:false` request leaves every
 *    tool callable. This mirrors the harness in `mastra-tool-execution.spec.ts`.
 */
import { ReadableStream } from 'node:stream/web';
import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2StreamPart,
} from '@ai-sdk/provider';
import { buildNativeToolRiskMap } from '@brainstrike/assistant-contract/tool-metadata';
import { createTool } from '@mastra/core/tools';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  type AssistantPermissionPolicyRequest,
  resolveRequestPermissionPolicy,
} from '../mastra/permission-policy-request';
import type { StreamChunk } from '../types';

const { modelHolder } = vi.hoisted(() => ({
  modelHolder: { current: undefined as LanguageModelV2 | undefined },
}));

vi.mock('../providers/provider-factory', async (importActual) => {
  const actual = await importActual<typeof import('../providers/provider-factory')>();
  return {
    ...actual,
    getDefaultModel: () => 'fake-model',
    createProvider: () => {
      if (!modelHolder.current) {
        throw new Error('test fake model was not configured');
      }
      return modelHolder.current;
    },
  };
});

const { streamMastraAgent } = await import('../mastra/agent-runtime');

const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 } as const;

// The two approval-gated workspace mutators — the only `edit`-risk native tools.
const EDIT_TOOL_A = 'brainstrike.updateWorkspaceContextSelection';
const EDIT_TOOL_B = 'brainstrike.updateWorkspaceTapestrySelections';
const READ_TOOL = 'brainstrike.readWorkspaceFile';

// The agent sanitizes a tool's id (`.` → `_`) into the name the MODEL must call;
// the permission gate maps the sanitized id back to the original via
// `toolNameMap`, so `riskByTool` (keyed by the original dotted id) still
// resolves. The scripted model below requests the SANITIZED name.
function sanitizedName(toolId: string): string {
  return toolId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function enqueue(parts: LanguageModelV2StreamPart[]): ReadableStream<LanguageModelV2StreamPart> {
  return new ReadableStream<LanguageModelV2StreamPart>({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part);
      }
      controller.close();
    },
  });
}

/**
 * A scripted model that requests `toolName` on the first turn, then emits a
 * final answer once the prompt carries a tool result.
 */
function createScriptedToolCallModel(args: {
  toolName: string;
  toolCallId: string;
  input: string;
  finalText: string;
}): LanguageModelV2 {
  return {
    specificationVersion: 'v2',
    provider: 'fake',
    modelId: 'fake-model',
    supportedUrls: {},
    doGenerate: () => Promise.reject(new Error('doGenerate is not used by this test')),
    doStream: (options: LanguageModelV2CallOptions) => {
      const promptHasToolResult =
        Array.isArray(options.prompt) && options.prompt.some((message) => message.role === 'tool');
      if (promptHasToolResult) {
        const id = 'text-final';
        return Promise.resolve({
          stream: enqueue([
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id },
            { type: 'text-delta', id, delta: args.finalText },
            { type: 'text-end', id },
            { type: 'finish', finishReason: 'stop', usage: USAGE },
          ]),
        });
      }
      return Promise.resolve({
        stream: enqueue([
          { type: 'stream-start', warnings: [] },
          {
            type: 'tool-call',
            toolCallId: args.toolCallId,
            toolName: args.toolName,
            input: args.input,
          },
          { type: 'finish', finishReason: 'tool-calls', usage: USAGE },
        ]),
      });
    },
  };
}

function makeNativeTools(executors: {
  editA: ReturnType<typeof vi.fn>;
  editB: ReturnType<typeof vi.fn>;
  read: ReturnType<typeof vi.fn>;
}): Record<string, ReturnType<typeof createTool>> {
  const inputSchema = z.object({ value: z.string() });
  const outputSchema = z.object({ ok: z.boolean() });
  return {
    [EDIT_TOOL_A]: createTool({
      id: EDIT_TOOL_A,
      description: 'Edit-risk workspace mutator A.',
      inputSchema,
      outputSchema,
      execute: executors.editA,
    }),
    [EDIT_TOOL_B]: createTool({
      id: EDIT_TOOL_B,
      description: 'Edit-risk workspace mutator B.',
      inputSchema,
      outputSchema,
      execute: executors.editB,
    }),
    [READ_TOOL]: createTool({
      id: READ_TOOL,
      description: 'Read-risk workspace reader.',
      inputSchema,
      outputSchema,
      execute: executors.read,
    }),
  };
}

describe('resolveRequestPermissionPolicy', () => {
  it('returns undefined when the request is absent (passthrough)', () => {
    expect(resolveRequestPermissionPolicy(undefined)).toBeUndefined();
  });

  it('returns undefined when enforce is false or absent (passthrough)', () => {
    expect(
      resolveRequestPermissionPolicy({
        enforce: false,
        policies: { read: 'allow', edit: 'deny', execute: 'ask', mcp: 'allow' },
      })
    ).toBeUndefined();
    expect(
      resolveRequestPermissionPolicy({
        policies: { read: 'allow', edit: 'deny', execute: 'ask', mcp: 'allow' },
      } as AssistantPermissionPolicyRequest)
    ).toBeUndefined();
  });

  it('builds a trusted snapshot with server-owned riskByTool + defaultRisk when enforce is true', () => {
    const snapshot = resolveRequestPermissionPolicy({
      enforce: true,
      policies: { read: 'allow', edit: 'deny', execute: 'ask', mcp: 'allow' },
      yolo: false,
      sessionGrants: ['execute'],
      perToolOverrides: { 'brainstrike.tool': 'allow' },
    });

    expect(snapshot).toBeDefined();
    if (!snapshot) {
      expect.unreachable('snapshot must be defined when enforce is true');
    }
    // Policy posture carried through verbatim...
    expect(snapshot.policies).toEqual({
      read: 'allow',
      edit: 'deny',
      execute: 'ask',
      mcp: 'allow',
    });
    expect(snapshot.yolo).toBe(false);
    expect(snapshot.sessionGrants).toEqual(['execute']);
    expect(snapshot.perToolOverrides).toEqual({ 'brainstrike.tool': 'allow' });
    // ...with the SERVER-built risk classification + restrictive default.
    expect(snapshot.riskByTool).toEqual(buildNativeToolRiskMap());
    expect(snapshot.defaultRisk).toBe('mcp');
    // The two known edit mutators classify as 'edit'.
    expect(snapshot.riskByTool?.[EDIT_TOOL_A]).toBe('edit');
    expect(snapshot.riskByTool?.[EDIT_TOOL_B]).toBe('edit');
    expect(snapshot.riskByTool?.[READ_TOOL]).toBe('read');
  });

  it('omits sessionGrants / perToolOverrides keys when not provided', () => {
    const snapshot = resolveRequestPermissionPolicy({
      enforce: true,
      policies: { read: 'allow', edit: 'ask', execute: 'ask', mcp: 'allow' },
    });
    if (!snapshot) {
      expect.unreachable('snapshot must be defined when enforce is true');
    }
    expect('sessionGrants' in snapshot).toBe(false);
    expect('perToolOverrides' in snapshot).toBe(false);
  });
});

describe('runtime gate fed by resolveRequestPermissionPolicy (real Mastra loop)', () => {
  async function runWithToolCall(args: {
    permissionPolicy: ReturnType<typeof resolveRequestPermissionPolicy>;
    toolName: string;
    tools: Record<string, ReturnType<typeof createTool>>;
  }): Promise<StreamChunk[]> {
    modelHolder.current = createScriptedToolCallModel({
      toolName: sanitizedName(args.toolName),
      toolCallId: `call-${sanitizedName(args.toolName)}`,
      input: JSON.stringify({ value: 'x' }),
      finalText: 'done',
    });
    const iterator = await streamMastraAgent(
      [{ id: 'u-1', role: 'user', parts: [{ type: 'text', text: 'go' }] }],
      {
        runtime: {
          provider: 'openai',
          apiKey: 'test-key',
          ...(args.permissionPolicy ? { permissionPolicy: args.permissionPolicy } : {}),
        },
        tools: args.tools,
      }
    );
    const chunks: StreamChunk[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }
    return chunks;
  }

  it("enforce:true + edit:'deny' OMITS the two edit native tools (execute never called), keeps read callable", async () => {
    const editA = vi.fn(() => Promise.resolve({ ok: true }));
    const editB = vi.fn(() => Promise.resolve({ ok: true }));
    const read = vi.fn(() => Promise.resolve({ ok: true }));

    const permissionPolicy = resolveRequestPermissionPolicy({
      enforce: true,
      policies: { read: 'allow', edit: 'deny', execute: 'ask', mcp: 'allow' },
      yolo: false,
    });
    expect(permissionPolicy).toBeDefined();

    // The model tries EDIT_TOOL_A: it must have been omitted, so execute never
    // runs and no successful tool completion surfaces.
    const editChunks = await runWithToolCall({
      permissionPolicy,
      toolName: EDIT_TOOL_A,
      tools: makeNativeTools({ editA, editB, read }),
    });
    expect(editA).not.toHaveBeenCalled();
    const editCompleted = editChunks.some(
      (chunk) => chunk.type === 'run-event' && chunk.event.kind === 'tool.completed'
    );
    expect(editCompleted).toBe(false);

    // The model tries EDIT_TOOL_B: same — omitted.
    const editBChunks = await runWithToolCall({
      permissionPolicy,
      toolName: EDIT_TOOL_B,
      tools: makeNativeTools({ editA, editB, read }),
    });
    expect(editB).not.toHaveBeenCalled();
    const editBCompleted = editBChunks.some(
      (chunk) => chunk.type === 'run-event' && chunk.event.kind === 'tool.completed'
    );
    expect(editBCompleted).toBe(false);

    // The read tool is 'allow' (read policy) — it stays in the map and executes.
    const readChunks = await runWithToolCall({
      permissionPolicy,
      toolName: READ_TOOL,
      tools: makeNativeTools({ editA, editB, read }),
    });
    expect(read).toHaveBeenCalledTimes(1);
    const readCompleted = readChunks.some(
      (chunk) => chunk.type === 'run-event' && chunk.event.kind === 'tool.completed'
    );
    expect(readCompleted).toBe(true);
  });

  it('enforce:false yields no permissionPolicy → all tools remain callable (passthrough)', async () => {
    const editA = vi.fn(() => Promise.resolve({ ok: true }));
    const editB = vi.fn(() => Promise.resolve({ ok: true }));
    const read = vi.fn(() => Promise.resolve({ ok: true }));

    // enforce:false → resolver returns undefined → runtime gets NO policy.
    const permissionPolicy = resolveRequestPermissionPolicy({
      enforce: false,
      policies: { read: 'allow', edit: 'deny', execute: 'ask', mcp: 'allow' },
    });
    expect(permissionPolicy).toBeUndefined();

    // Even an 'edit'-deny policy is irrelevant — it was never sent. The edit tool
    // executes normally.
    const chunks = await runWithToolCall({
      permissionPolicy,
      toolName: EDIT_TOOL_A,
      tools: makeNativeTools({ editA, editB, read }),
    });
    expect(editA).toHaveBeenCalledTimes(1);
    const completed = chunks.some(
      (chunk) => chunk.type === 'run-event' && chunk.event.kind === 'tool.completed'
    );
    expect(completed).toBe(true);
  });
});
