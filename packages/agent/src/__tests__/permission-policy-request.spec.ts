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
    createProvider: () => {
      if (!modelHolder.current) {
        throw new Error('test fake model was not configured');
      }
      return modelHolder.current;
    },
    getDefaultModel: (provider: string) =>
      ({
        anthropic: 'claude-sonnet-5',
        google: 'gemini-3.5-flash',
        local: 'onnx-community/gemma-4-E2B-it-ONNX',
        openrouter: 'openai/gpt-5.6-terra',
      })[provider] ?? 'gpt-5.6-terra',
  };
});

const { streamMastraAgent } = await import('../mastra/agent-streaming');

const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 } as const;

// One critical and one deferred edit-risk mutator. The critical tool keeps the
// direct execution assertions independent from discovery; the deferred tool
// proves the permission gate removes it before the searchable catalog is built.
const EDIT_TOOL_A = 'brainstrike.stringReplaceWorkspaceFile';
const EDIT_TOOL_B = 'brainstrike.writeWorkspaceFile';
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
    doGenerate: () => Promise.reject(new Error('doGenerate is not used by this test')),
    doStream: (options: LanguageModelV2CallOptions) => {
      const promptHasToolResult =
        Array.isArray(options.prompt) && options.prompt.some((message) => message.role === 'tool');
      if (promptHasToolResult) {
        const id = 'text-final';
        return Promise.resolve({
          stream: enqueue([
            { type: 'stream-start', warnings: [] },
            { id, type: 'text-start' },
            { delta: args.finalText, id, type: 'text-delta' },
            { id, type: 'text-end' },
            { finishReason: 'stop', type: 'finish', usage: USAGE },
          ]),
        });
      }
      return Promise.resolve({
        stream: enqueue([
          { type: 'stream-start', warnings: [] },
          {
            input: args.input,
            toolCallId: args.toolCallId,
            toolName: args.toolName,
            type: 'tool-call',
          },
          { finishReason: 'tool-calls', type: 'finish', usage: USAGE },
        ]),
      });
    },
    modelId: 'fake-model',
    provider: 'fake',
    specificationVersion: 'v2',
    supportedUrls: {},
  };
}

function makeNativeTools(executors: {
  editA: () => Promise<{ ok: boolean }>;
  editB: () => Promise<{ ok: boolean }>;
  read: () => Promise<{ ok: boolean }>;
}): Record<string, ReturnType<typeof createTool>> {
  const inputSchema = z.object({ value: z.string() });
  const outputSchema = z.object({ ok: z.boolean() });
  return {
    [EDIT_TOOL_A]: createTool({
      description: 'Edit-risk workspace mutator A.',
      execute: executors.editA,
      id: EDIT_TOOL_A,
      inputSchema,
      outputSchema,
    }),
    [EDIT_TOOL_B]: createTool({
      description: 'Edit-risk workspace mutator B.',
      execute: executors.editB,
      id: EDIT_TOOL_B,
      inputSchema,
      outputSchema,
    }),
    [READ_TOOL]: createTool({
      description: 'Read-risk workspace reader.',
      execute: executors.read,
      id: READ_TOOL,
      inputSchema,
      outputSchema,
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
        policies: { edit: 'deny', execute: 'ask', mcp: 'allow', read: 'allow' },
      })
    ).toBeUndefined();
    expect(
      resolveRequestPermissionPolicy({
        policies: { edit: 'deny', execute: 'ask', mcp: 'allow', read: 'allow' },
      } as AssistantPermissionPolicyRequest)
    ).toBeUndefined();
  });

  it('builds a trusted snapshot with server-owned riskByTool + defaultRisk when enforce is true', () => {
    const snapshot = resolveRequestPermissionPolicy({
      enforce: true,
      perToolOverrides: { 'brainstrike.tool': 'allow' },
      policies: { edit: 'deny', execute: 'ask', mcp: 'allow', read: 'allow' },
      sessionGrants: ['execute'],
      yolo: false,
    });

    expect(snapshot).toBeDefined();
    if (!snapshot) {
      expect.unreachable('snapshot must be defined when enforce is true');
    }
    // Policy posture carried through verbatim...
    expect(snapshot.policies).toEqual({
      edit: 'deny',
      execute: 'ask',
      mcp: 'allow',
      read: 'allow',
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
      policies: { edit: 'ask', execute: 'ask', mcp: 'allow', read: 'allow' },
    });
    if (!snapshot) {
      expect.unreachable('snapshot must be defined when enforce is true');
    }
    expect('sessionGrants' in snapshot).toBe(false);
    expect('perToolOverrides' in snapshot).toBe(false);
  });
});

/**
 * Wire-shape contract for `RuntimeData['permissionPolicyRequest']`.
 *
 * The sole producer (`prepareRequestData` in
 * `packages/app-shell/src/hooks/use-assistant-request-lifecycle.ts`) writes the
 * key UNCONDITIONALLY — the snapshot when enforceable + opted in, otherwise an
 * explicit `undefined` that `JSON.stringify` drops. On the producer's object the
 * key is therefore PRESENT-and-undefined while every consumer reads the VALUE,
 * so a `'permissionPolicyRequest' in runtimeData` guard would read an opted-out
 * request as "opted in". These cases pin the resolver half (absent key and
 * explicit `undefined` are indistinguishable to it, and an opted-in snapshot
 * still survives serialization); the producer half — that the opted-out object
 * really does carry the key — is pinned by "leaves the key PRESENT with an
 * undefined value" in
 * `packages/app-shell/src/__tests__/use-assistant-request-lifecycle.test.ts`.
 */
describe('permissionPolicyRequest wire-shape contract (absent key vs explicit undefined)', () => {
  // `| undefined` is REQUIRED here: the repo runs `exactOptionalPropertyTypes`,
  // under which a plain `?:` property rejects an explicit `undefined`. The
  // producer escapes that check only because `prepareRequestData` is typed
  // `Record<string, unknown>` — see the block comment above.
  interface RuntimeDataFieldReader {
    permissionPolicyRequest?: AssistantPermissionPolicyRequest | undefined;
  }

  const enforcing: AssistantPermissionPolicyRequest = {
    enforce: true,
    policies: { edit: 'ask', execute: 'ask', mcp: 'allow', read: 'allow' },
  };

  const absentKey: RuntimeDataFieldReader = {};
  const explicitUndefined: RuntimeDataFieldReader = { permissionPolicyRequest: undefined };

  it('resolves the two opted-out shapes identically (passthrough)', () => {
    expect(resolveRequestPermissionPolicy(absentKey.permissionPolicyRequest)).toBeUndefined();
    expect(
      resolveRequestPermissionPolicy(explicitUndefined.permissionPolicyRequest)
    ).toBeUndefined();
  });

  it('still carries an opted-in snapshot across the JSON boundary', () => {
    const serialized = JSON.parse(
      JSON.stringify({ permissionPolicyRequest: enforcing } satisfies RuntimeDataFieldReader)
    ) as RuntimeDataFieldReader;

    const snapshot = resolveRequestPermissionPolicy(serialized.permissionPolicyRequest);

    expect(snapshot?.policies).toEqual(enforcing.policies);
    expect(snapshot?.defaultRisk).toBe('mcp');
  });
});

describe('runtime gate fed by resolveRequestPermissionPolicy (real Mastra loop)', () => {
  async function runWithToolCall(args: {
    permissionPolicy: ReturnType<typeof resolveRequestPermissionPolicy>;
    toolName: string;
    tools: Record<string, ReturnType<typeof createTool>>;
  }): Promise<StreamChunk[]> {
    modelHolder.current = createScriptedToolCallModel({
      finalText: 'done',
      input: JSON.stringify({ value: 'x' }),
      toolCallId: `call-${sanitizedName(args.toolName)}`,
      toolName: sanitizedName(args.toolName),
    });
    const iterator = await streamMastraAgent(
      [{ id: 'u-1', parts: [{ text: 'go', type: 'text' }], role: 'user' }],
      {
        runtime: {
          apiKey: 'test-key',
          provider: 'openai',
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
      policies: { edit: 'deny', execute: 'ask', mcp: 'allow', read: 'allow' },
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
      policies: { edit: 'deny', execute: 'ask', mcp: 'allow', read: 'allow' },
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
