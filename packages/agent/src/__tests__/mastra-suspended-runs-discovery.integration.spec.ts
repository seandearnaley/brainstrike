/**
 * D1 regression proof: the suspended-run DISCOVERY path must build its runtime
 * with ZERO provider configuration and NO inference.
 *
 * Unlike mastra-tool-approval-suspend.spec.ts, this file deliberately does NOT
 * mock `../providers/provider-factory` — it exercises the REAL `getDefaultModel`
 * / `createProvider`. The mocked suites historically returned a synthetic model id,
 * which masked the live 500: the desktop discovery route builds the listing
 * runtime with `provider: 'ollama'`, but ollama has NO static default model, so
 * the pre-fix `createMastraAgentRuntime` threw `No default model configured for
 * provider: ollama` at init — before any listing ran (the `/assistant/suspended-runs`
 * 500 the smoke reproduced). With the inert listing-only model this path resolves
 * no provider/model and succeeds.
 */
import type { LanguageModelV2, LanguageModelV2StreamPart } from '@ai-sdk/provider';
import { PGlite } from '@electric-sql/pglite';
import { createTool } from '@mastra/core/tools';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { streamMastraAgent } from '../mastra/agent-streaming';
import { listSuspendedMastraRuns } from '../mastra/suspended-run-discovery';
import { createPgliteMastraMemory, type PgliteDatabase } from '../pglite-mastra-memory';
import type { StreamChunk } from '../types';

/**
 * A one-turn scripted model that calls `toolName` (the REGISTERED — i.e.
 * sanitized — id, exactly what a real provider sees) and stops. Passed through
 * `modelOverride` so the suspend phase needs no provider mock: this file
 * deliberately keeps the REAL provider-factory (see the module doc above), and
 * `modelOverride` bypasses model construction without touching that path.
 */
function createSuspendingToolCallModel(args: {
  toolName: string;
  toolCallId: string;
  input: string;
}): LanguageModelV2 {
  const enqueue = (parts: LanguageModelV2StreamPart[]) =>
    new ReadableStream<LanguageModelV2StreamPart>({
      start(controller) {
        for (const part of parts) {
          controller.enqueue(part);
        }
        controller.close();
      },
    });
  return {
    doGenerate: () => Promise.reject(new Error('doGenerate is not used by this test')),
    doStream: () =>
      Promise.resolve({
        stream: enqueue([
          { type: 'stream-start', warnings: [] },
          {
            input: args.input,
            toolCallId: args.toolCallId,
            toolName: args.toolName,
            type: 'tool-call',
          },
          {
            finishReason: 'tool-calls',
            type: 'finish',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ]),
      }),
    modelId: 'scripted-model',
    provider: 'fake',
    specificationVersion: 'v2',
    supportedUrls: {},
  };
}

/** Drain with a per-chunk macrotask yield (mirrors the suspend spec's harness note). */
async function drainYielding(iterator: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of iterator) {
    chunks.push(chunk);
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
  return chunks;
}

describe('listSuspendedMastraRuns (real provider-factory, zero provider config)', () => {
  let database: PGlite;

  beforeEach(() => {
    database = new PGlite();
  });

  afterEach(async () => {
    await database.close();
  });

  it('builds a listing runtime with a keyless provider that has no static default model (D1)', async () => {
    const { memory, storage } = await createPgliteMastraMemory({
      database: database as unknown as PgliteDatabase,
    });
    const thread = {
      resourceId: 'resource-discovery-d1',
      threadId: 'thread-discovery-d1',
    } as const;

    // Exactly the desktop route's runtime config: keyless `ollama`, no apiKey, no
    // model. Pre-fix this threw `No default model configured for provider: ollama`
    // during runtime init (the D1 500). Post-fix, listing resolves no model and
    // returns an empty result against the empty storage.
    const result = await listSuspendedMastraRuns(
      { resourceId: thread.resourceId, threadId: thread.threadId },
      {
        memory,
        runtime: {
          memory: { resourceId: thread.resourceId, threadId: thread.threadId },
          provider: 'ollama',
        },
        storage,
      }
    );

    expect(result).toEqual({ approvals: [], suspends: [] });
  });

  it('returns the ORIGINAL dotted tool name for a rediscovered approval when the tool is registered (name-keying integrity)', async () => {
    // The confirmed live bug class: Mastra stores the suspended tool call under
    // the REGISTERED (sanitized) id (`shell_tool`), but every client-facing
    // approval surface is keyed by the ORIGINAL dotted name (`shell.tool`) —
    // riskByTool lookups, per-tool overrides, the notice label. Discovery must
    // map back through the runtime's toolNameMap.
    const askExecute = vi.fn((inputData: { command: string }) =>
      Promise.resolve({ ran: inputData.command })
    );
    const dottedTool = createTool({
      description: 'An execute-risk tool registered under a DOTTED id.',
      execute: askExecute,
      id: 'shell.tool',
      inputSchema: z.object({ command: z.string() }),
      outputSchema: z.object({ ran: z.string() }),
    });
    const policy = {
      policies: { edit: 'deny', execute: 'ask', mcp: 'allow', read: 'allow' },
      riskByTool: { 'shell.tool': 'execute' },
      yolo: false,
    } as const;
    const thread = {
      resourceId: 'resource-discovery-dotted',
      threadId: 'thread-discovery-dotted',
    } as const;
    const { memory, storage } = await createPgliteMastraMemory({
      database: database as unknown as PgliteDatabase,
    });

    // ── Phase 1: SUSPEND. The scripted model calls the REGISTERED id. ──
    const suspendChunks = await drainYielding(
      await streamMastraAgent(
        [{ id: 'u-dotted-1', parts: [{ text: 'run echo', type: 'text' }], role: 'user' }],
        {
          memory,
          modelOverride: createSuspendingToolCallModel({
            input: JSON.stringify({ command: 'echo dotted' }),
            toolCallId: 'call-dotted-1',
            toolName: 'shell_tool',
          }),
          runtime: {
            apiKey: 'test-key',
            memory: { resourceId: thread.resourceId, threadId: thread.threadId },
            permissionPolicy: policy,
            provider: 'openai',
          },
          storage,
          tools: { 'shell.tool': dottedTool },
        }
      )
    );
    expect(suspendChunks.find((chunk) => chunk.type === 'tool-approval-required')).toBeDefined();
    expect(askExecute).not.toHaveBeenCalled();

    // ── Phase 2: rediscovery with the tool registered (runtime.toolNameMap
    //    carries sanitized→original) must surface the ORIGINAL dotted name. ──
    const discovery = await listSuspendedMastraRuns(
      { resourceId: thread.resourceId, threadId: thread.threadId },
      {
        memory,
        runtime: {
          memory: { resourceId: thread.resourceId, threadId: thread.threadId },
          provider: 'ollama',
        },
        storage,
        tools: { 'shell.tool': dottedTool },
      }
    );

    expect(discovery.approvals).toHaveLength(1);
    expect(discovery.approvals[0]?.toolName).toBe('shell.tool');
  });

  it('maps a KEYLESS (no tools registered) rediscovered NATIVE approval back to its dotted id — the desktop route shape', async () => {
    // The desktop /assistant/suspended-runs route calls discovery with NO tools
    // (keyless, context-free). For KNOWN native ids the static contract map
    // (`denormalizeNativeToolName`) restores the dotted form, so the route's
    // `buildNativeToolRiskMap()[toolName]` lookup hits and rediscovered
    // approvals carry riskCategory + working grant actions.
    const execute = vi.fn((inputData: { command: string }) =>
      Promise.resolve({ ran: inputData.command })
    );
    const nativeLikeTool = createTool({
      description: 'A native execute tool registered under its dotted id.',
      execute,
      id: 'brainstrike.executeCommand',
      inputSchema: z.object({ command: z.string() }),
      outputSchema: z.object({ ran: z.string() }),
    });
    const policy = {
      policies: { edit: 'deny', execute: 'ask', mcp: 'allow', read: 'allow' },
      riskByTool: { 'brainstrike.executeCommand': 'execute' },
      yolo: false,
    } as const;
    const thread = {
      resourceId: 'resource-discovery-native',
      threadId: 'thread-discovery-native',
    } as const;
    const { memory, storage } = await createPgliteMastraMemory({
      database: database as unknown as PgliteDatabase,
    });

    const suspendChunks = await drainYielding(
      await streamMastraAgent(
        [{ id: 'u-native-1', parts: [{ text: 'run echo', type: 'text' }], role: 'user' }],
        {
          memory,
          modelOverride: createSuspendingToolCallModel({
            input: JSON.stringify({ command: 'echo native' }),
            toolCallId: 'call-native-1',
            toolName: 'brainstrike_executeCommand',
          }),
          runtime: {
            apiKey: 'test-key',
            memory: { resourceId: thread.resourceId, threadId: thread.threadId },
            permissionPolicy: policy,
            provider: 'openai',
          },
          storage,
          tools: { 'brainstrike.executeCommand': nativeLikeTool },
        }
      )
    );
    expect(suspendChunks.find((chunk) => chunk.type === 'tool-approval-required')).toBeDefined();

    // EXACTLY the desktop route's discovery options: keyless ollama, NO tools.
    const discovery = await listSuspendedMastraRuns(
      { resourceId: thread.resourceId, threadId: thread.threadId },
      {
        memory,
        runtime: {
          memory: { resourceId: thread.resourceId, threadId: thread.threadId },
          provider: 'ollama',
        },
        storage,
      }
    );

    expect(discovery.approvals).toHaveLength(1);
    expect(discovery.approvals[0]?.toolName).toBe('brainstrike.executeCommand');
  });
});
