/**
 * LIVE-loop proof for the tool `suspend()` / `resumeData` round-trip — the server
 * seam behind the WEB file-write bridge (P2). Distinct from the permission-gate
 * `requireApproval` approval flow (mastra-tool-approval-suspend.spec.ts): here a
 * tool declares `suspendSchema`/`resumeSchema` and `suspend()`s itself; the
 * resume carries `resumeData` that the tool's `execute` reads and RETURNS.
 *
 * Drives the REAL Mastra agent loop (only the language model is a scripted fake)
 * with REAL PGlite-backed workflow storage. Proves:
 *   - a `suspend()` pauses the run and surfaces the suspendPayload + runId/toolCallId,
 *   - `streamMastraToolSuspendResume(resumeData)` resumes via `agent.resumeStream`,
 *     the tool reads `resumeData` and RETURNS it → the run continues,
 *   - a `{ok:false}` resumeData makes the tool THROW (no silent success).
 *
 * Own file (not bundled) so the heavy real-PGlite suspend/resume runs stay
 * isolated from env-mutating stall/timeout tests, per the approval spec's note.
 */
import { ReadableStream } from 'node:stream/web';
import type { LanguageModelV2, LanguageModelV2StreamPart } from '@ai-sdk/provider';
import { PGlite } from '@electric-sql/pglite';
import { createTool } from '@mastra/core/tools';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { PgliteDatabase, PgliteMastraMemoryOptions } from '../pglite-mastra-memory';
import type { StreamChunk } from '../types';

const { modelHolder } = vi.hoisted(() => ({
  modelHolder: { current: undefined as LanguageModelV2 | undefined },
}));

// Replace ONLY model construction — the real Agent, tool loop, and suspend/resume
// run unmocked.
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

const { streamMastraAgent, streamMastraToolSuspendResume } = await import(
  '../mastra/agent-runtime'
);
const { createPgliteMastraMemory } = await import('../pglite-mastra-memory');

const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 } as const;

function createTurnCountedToolCallModel(args: {
  toolName: string;
  toolCallId: string;
  input: string;
  finalText: string;
}): LanguageModelV2 {
  let turn = 0;
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
    specificationVersion: 'v2',
    provider: 'fake',
    modelId: 'fake-model',
    supportedUrls: {},
    doGenerate: () => Promise.reject(new Error('doGenerate is not used by this test')),
    doStream: () => {
      turn += 1;
      if (turn === 1) {
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
      }
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
    },
  };
}

interface SuspendToolContext {
  agent?: {
    suspend?: (payload: unknown) => Promise<unknown>;
    resumeData?: { ok: boolean; bytesWritten?: number; error?: string };
  };
}

/**
 * A tool that DELEGATES its work by suspending: on first execute (no resumeData)
 * it `suspend()`s with the request; on resume it reads `resumeData` and returns
 * it (throwing on `!ok` — the renderer-side write failed). Mirrors the web
 * write tool's intended shape.
 */
function makeSuspendingWriteTool(onSuspend: () => void) {
  return createTool({
    id: 'write_file',
    description: 'Writes a file via the renderer; suspends to delegate the FSA write.',
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    outputSchema: z.object({ ok: z.boolean(), bytesWritten: z.number().optional() }),
    suspendSchema: z.object({ path: z.string(), content: z.string(), byteLength: z.number() }),
    resumeSchema: z.object({
      ok: z.boolean(),
      bytesWritten: z.number().optional(),
      error: z.string().optional(),
    }),
    execute: async (inputData: { path: string; content: string }, context?: SuspendToolContext) => {
      const resumeData = context?.agent?.resumeData;
      if (!resumeData) {
        onSuspend();
        return context?.agent?.suspend?.({
          path: inputData.path,
          content: inputData.content,
          byteLength: new TextEncoder().encode(inputData.content).byteLength,
        });
      }
      if (!resumeData.ok) {
        throw new Error(resumeData.error ?? 'web fs write failed');
      }
      return { ok: true, bytesWritten: resumeData.bytesWritten };
    },
  });
}

function makeMemory(database: PGlite) {
  const options: PgliteMastraMemoryOptions = {
    database: database as unknown as PgliteDatabase,
  };
  return createPgliteMastraMemory(options);
}

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

interface SuspendEventPayload {
  readonly runId?: string;
  readonly suspended?: boolean;
  readonly suspendPayload?: { path?: string; content?: string; byteLength?: number };
  readonly toolCallId?: string;
}

function findSuspendEvent(chunks: StreamChunk[]) {
  return chunks.find(
    (chunk): chunk is Extract<StreamChunk, { type: 'tool-event' }> =>
      chunk.type === 'tool-event' &&
      (chunk.payload as SuspendEventPayload | undefined)?.suspended === true
  );
}

const RUNTIME = {
  provider: 'openai',
  apiKey: 'test-key',
  memory: { threadId: 'thread-suspend-1', resourceId: 'resource-suspend-1' },
} as const;

describe('tool suspend()/resumeData round-trip (real @mastra/core/agent + real PGlite)', () => {
  beforeEach(() => {
    modelHolder.current = undefined;
  });

  it('suspends with the request, then resumeData is returned by the tool and the run continues', async () => {
    const database = new PGlite();
    const { memory, storage } = await makeMemory(database);
    const onSuspend = vi.fn();
    const writeTool = makeSuspendingWriteTool(onSuspend);

    modelHolder.current = createTurnCountedToolCallModel({
      toolName: 'write_file',
      toolCallId: 'call-write-1',
      input: JSON.stringify({ path: 'src/foo.ts', content: 'export const x = 1;\n' }),
      finalText: 'Wrote the file.',
    });

    // ── Phase 1: the run SUSPENDS, handing the write request to the caller ──
    const suspendIterator = await streamMastraAgent(
      [{ id: 'u-1', role: 'user', parts: [{ type: 'text', text: 'write the file' }] }],
      { memory, storage, runtime: RUNTIME, tools: { write_file: writeTool } }
    );
    const suspendChunks = await drainYielding(suspendIterator);

    const suspendEvent = findSuspendEvent(suspendChunks);
    expect(suspendEvent).toBeDefined();
    const payload = suspendEvent?.payload as SuspendEventPayload;
    expect(payload.suspendPayload?.path).toBe('src/foo.ts');
    expect(payload.suspendPayload?.content).toBe('export const x = 1;\n');
    expect(payload.runId).toBeTruthy();
    expect(payload.toolCallId).toBeTruthy();
    expect(onSuspend).toHaveBeenCalledTimes(1);

    // ── Phase 2: resume with the renderer's write result as resumeData ──
    const resumeIterator = await streamMastraToolSuspendResume(
      {
        runId: payload.runId ?? '',
        toolCallId: payload.toolCallId ?? '',
        resumeData: { ok: true, bytesWritten: 20 },
      },
      { memory, storage, runtime: RUNTIME, tools: { write_file: writeTool } }
    );
    const resumeChunks = await drainYielding(resumeIterator);

    // The tool resumed, read resumeData, and the run continued to completion.
    const resumeRunEventKinds = resumeChunks
      .filter(
        (chunk): chunk is Extract<StreamChunk, { type: 'run-event' }> => chunk.type === 'run-event'
      )
      .map((chunk) => chunk.event.kind);
    expect(resumeRunEventKinds).toContain('tool.completed');
    expect(resumeChunks.find((chunk) => chunk.type === 'message-finish')).toBeDefined();

    await database.close();
  });

  it('a {ok:false} resumeData makes the tool THROW (no silent success)', async () => {
    const database = new PGlite();
    const { memory, storage } = await makeMemory(database);
    const writeTool = makeSuspendingWriteTool(vi.fn());

    modelHolder.current = createTurnCountedToolCallModel({
      toolName: 'write_file',
      toolCallId: 'call-write-2',
      input: JSON.stringify({ path: 'src/bar.ts', content: 'export const y = 2;\n' }),
      finalText: 'Done.',
    });

    const suspendChunks = await drainYielding(
      await streamMastraAgent(
        [{ id: 'u-2', role: 'user', parts: [{ type: 'text', text: 'write bar' }] }],
        { memory, storage, runtime: RUNTIME, tools: { write_file: writeTool } }
      )
    );
    const payload = findSuspendEvent(suspendChunks)?.payload as SuspendEventPayload;
    expect(payload?.runId).toBeTruthy();

    const resumeChunks = await drainYielding(
      await streamMastraToolSuspendResume(
        {
          runId: payload.runId ?? '',
          toolCallId: payload.toolCallId ?? '',
          resumeData: { ok: false, error: 'fs_write_permission_denied' },
        },
        { memory, storage, runtime: RUNTIME, tools: { write_file: writeTool } }
      )
    );

    // The failed write surfaces as a tool error (`isError`) + a `tool.failed`
    // run-event — never a silent success. (The run itself then continues: the
    // model sees the tool error and responds, which is the intended behavior.)
    const sawFailure = resumeChunks.some(
      (chunk) =>
        (chunk.type === 'tool-event' &&
          (chunk.payload as { isError?: boolean })?.isError === true) ||
        (chunk.type === 'run-event' && chunk.event.kind === 'tool.failed')
    );
    expect(sawFailure).toBe(true);

    await database.close();
  });
});
