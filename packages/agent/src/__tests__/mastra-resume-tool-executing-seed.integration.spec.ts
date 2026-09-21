/**
 * BST-1777 final review (I1): a Mastra APPROVAL-RESUME leg never replays the
 * suspended step's `tool-call` part (see `resumedApprovalToolCall` at
 * `../mastra/agent-streaming.ts`), so without seeding, the tool that just
 * started executing on this leg has no `started` boundary for the watchdog to
 * observe and is measured against the PROVIDER's own silence budget
 * (`streamFirstOutputMs`) instead of the `tool-executing` backstop.
 *
 * Drives the REAL Mastra suspend/resume loop (real PGlite storage, only the
 * language model is scripted) — the smallest seam that can observe the
 * production wiring in `collectResumedGuardedToolCallIds` /
 * `streamAttemptChunks`, mirrored on
 * `mastra-tool-approval-suspend.integration.spec.ts`'s approve-and-execute
 * case. `BRAINSTRIKE_STREAM_FIRST_OUTPUT_MS` is shrunk far below the tool's
 * silent execute so the RED case (seeding reverted) is a fast, deterministic
 * `stream_inactivity_timeout` rather than a 600s wait.
 */
import type { LanguageModelV2, LanguageModelV2StreamPart } from '@ai-sdk/provider';
import { PGlite } from '@electric-sql/pglite';
import { createTool } from '@mastra/core/tools';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { PgliteDatabase, PgliteMastraMemoryOptions } from '../pglite-mastra-memory';
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
    getDefaultModel: () => 'gpt-5.6-terra',
  };
});

const { streamMastraAgent, streamMastraToolApprovalAction } = await import(
  '../mastra/agent-streaming'
);
const { createPgliteMastraMemory } = await import('../pglite-mastra-memory');

const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 } as const;
const ASK_POLICY = {
  policies: { edit: 'deny', execute: 'ask', mcp: 'allow', read: 'allow' },
  riskByTool: { shell_tool: 'execute' },
  yolo: false,
} as const;

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

/** Turn 1 calls the ask tool; turn 2 (the resume) answers `done`. */
function createTurnCountedToolCallModel(): LanguageModelV2 {
  let turn = 0;
  return {
    doGenerate: () => Promise.reject(new Error('doGenerate is not used by this test')),
    doStream: () => {
      turn += 1;
      if (turn === 1) {
        return Promise.resolve({
          stream: enqueue([
            { type: 'stream-start', warnings: [] },
            {
              input: JSON.stringify({ command: 'echo approved' }),
              toolCallId: 'call-resume-seed-1',
              toolName: 'shell_tool',
              type: 'tool-call',
            },
            { finishReason: 'tool-calls', type: 'finish', usage: USAGE },
          ]),
        });
      }
      return Promise.resolve({
        stream: enqueue([
          { type: 'stream-start', warnings: [] },
          { id: 'f', type: 'text-start' },
          { delta: 'done', id: 'f', type: 'text-delta' },
          { id: 'f', type: 'text-end' },
          { finishReason: 'stop', type: 'finish', usage: USAGE },
        ]),
      });
    },
    modelId: 'fake-model',
    provider: 'fake',
    specificationVersion: 'v2',
    supportedUrls: {},
  };
}

function makeSleepyAskTool(sleepMs: number) {
  return createTool({
    description: 'An execute-risk tool gated to ask that sleeps silently after approval.',
    execute: () =>
      new Promise<{ ran: string }>((resolve) => {
        setTimeout(() => resolve({ ran: 'echo approved' }), sleepMs);
      }),
    id: 'shell_tool',
    inputSchema: z.object({ command: z.string() }),
    outputSchema: z.object({ ran: z.string() }),
  });
}

async function makeMemory(database: PGlite) {
  const options: PgliteMastraMemoryOptions = {
    database: database as unknown as PgliteDatabase,
  };
  return await createPgliteMastraMemory(options);
}

function findApprovalChunk(chunks: StreamChunk[]) {
  return chunks.find(
    (chunk): chunk is Extract<StreamChunk, { type: 'tool-approval-required' }> =>
      chunk.type === 'tool-approval-required'
  );
}

function findRunFailed(chunks: readonly StreamChunk[]) {
  return chunks.find(
    (chunk): chunk is Extract<StreamChunk, { type: 'run-event' }> =>
      chunk.type === 'run-event' && chunk.event.kind === 'run.failed'
  );
}

/** See `drainYielding` in `mastra-tool-approval-suspend.integration.spec.ts`. */
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

const ENV_KEYS = [
  'BRAINSTRIKE_STREAM_INACTIVITY_MS',
  'BRAINSTRIKE_STREAM_FIRST_OUTPUT_MS',
] as const;

describe('a resumed approved tool call seeds the tool-executing phase (real Mastra loop)', () => {
  beforeEach(() => {
    modelHolder.current = undefined;
    // Shrunk far below SLEEP_MS so the RED case (no seeding) stalls fast in
    // `awaiting-output` instead of waiting out the 600s production default.
    process.env['BRAINSTRIKE_STREAM_INACTIVITY_MS'] = '50';
    process.env['BRAINSTRIKE_STREAM_FIRST_OUTPUT_MS'] = '100';
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      Reflect.deleteProperty(process.env, key);
    }
  });

  const SLEEP_MS = 400;

  it('the approved tool executing past firstOutputMs does not stall the resume leg', async () => {
    const database = new PGlite();
    const { memory, storage } = await makeMemory(database);
    const askTool = makeSleepyAskTool(SLEEP_MS);
    const thread = { resourceId: 'resource-seed-1', threadId: 'thread-seed-1' } as const;

    modelHolder.current = createTurnCountedToolCallModel();

    const suspendIterator = await streamMastraAgent(
      [{ id: 'u-seed-1', parts: [{ text: 'run echo', type: 'text' }], role: 'user' }],
      {
        memory,
        runtime: {
          apiKey: 'test-key',
          memory: { resourceId: thread.resourceId, threadId: thread.threadId },
          permissionPolicy: ASK_POLICY,
          provider: 'openai',
        },
        storage,
        tools: { shell_tool: askTool },
      }
    );
    const suspendChunks = await drainYielding(suspendIterator);
    const approval = findApprovalChunk(suspendChunks);
    expect(approval).toBeDefined();

    const resumeIterator = await streamMastraToolApprovalAction(
      {
        action: 'approve',
        runId: approval?.runId ?? '',
        toolCallId: approval?.toolCallId ?? '',
        toolName: 'shell_tool',
      },
      {
        memory,
        requireToolApproval: true,
        runtime: {
          apiKey: 'test-key',
          memory: { resourceId: thread.resourceId, threadId: thread.threadId },
          permissionPolicy: ASK_POLICY,
          provider: 'openai',
        },
        storage,
        tools: { shell_tool: askTool },
      }
    );
    const resumeChunks = await drainYielding(resumeIterator);

    // The point of this test: with the call seeded into `tool-executing`, a
    // silence that dwarfs `firstOutputMs` (100ms, vs. this tool's 400ms sleep)
    // must NOT be reported as a stall at all.
    const failure = findRunFailed(resumeChunks);
    expect(failure).toBeUndefined();
    const finish = resumeChunks.find((chunk) => chunk.type === 'message-finish');
    expect(finish).toBeDefined();

    await database.close();
  }, 15_000);
});
