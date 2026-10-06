import { spawn } from 'node:child_process';
import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { processStartTime } from '@brainstrike/state-store';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { z } from 'zod';
import type { HostPlatform, HostTool } from '../../src/ports.js';
import { startAgentHost } from '../../src/runtime.js';

type Chunk =
  Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer C>
    ? C
    : never;
const Identity = z.strictObject({
  executable: z.string(),
  pid: z.number().int().positive(),
  start: z.string().regex(/^\d+$/),
});
const ChildReady = z.strictObject({ event: z.literal('child-ready'), identity: Identity });

async function main(): Promise<void> {
  const root = z.string().min(1).parse(process.argv[2]);
  const mode = z.enum(['approval', 'child']).parse(process.argv[3]);
  const startRequested = Promise.withResolvers<void>();
  const closeRequested = Promise.withResolvers<void>();
  let closing = false;
  const control = (input: unknown): void => {
    if (z.enum(['start', 'close']).parse(input) === 'start') {
      startRequested.resolve();
    } else {
      closing = true;
      closeRequested.resolve();
      startRequested.resolve();
    }
  };
  process.on('message', control);
  process.once('disconnect', () => control('close'));
  // The parent records the real PID/FILETIME/executable before admitting startup.
  await startRequested.promise;
  if (closing) {
    process.off('message', control);
    return;
  }
  let step = 0;
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      // Like this checkpoint's scripted SDK fixture, choose from committed context,
      // so a fresh process does not issue the already-completed call again.
      const latestUser = options.prompt.findLastIndex((entry) => entry.role === 'user');
      const completedToolCallIds = options.prompt
        .slice(latestUser)
        .flatMap((entry) =>
          entry.role === 'tool'
            ? entry.content
                .filter((part) => part.type === 'tool-result')
                .map((part) => part.toolCallId)
            : []
        );
      await appendFile(
        join(root, 'model-calls.jsonl'),
        `${JSON.stringify({ completedToolCallIds, pid: process.pid, step: step++ })}\n`
      );
      // Pinned provider-v4 payloads match the existing host integration fixture.
      const chunks: Chunk[] = completedToolCallIds.includes('windows-recorded-call-1')
        ? [
            { type: 'stream-start', warnings: [] },
            { id: 'windows-text-1', type: 'text-start' },
            { delta: 'Windows host run completed.', id: 'windows-text-1', type: 'text-delta' },
            { id: 'windows-text-1', type: 'text-end' },
            {
              finishReason: { raw: 'stop', unified: 'stop' },
              type: 'finish',
              usage: {
                inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
                outputTokens: { reasoning: 0, text: 1, total: 1 },
              },
            },
          ]
        : [
            { type: 'stream-start', warnings: [] },
            {
              input: JSON.stringify({ text: 'one approved Windows effect' }),
              toolCallId: 'windows-recorded-call-1',
              toolName: 'owned_effect',
              type: 'tool-call',
            },
            {
              finishReason: { raw: 'tool_calls', unified: 'tool-calls' },
              type: 'finish',
              usage: {
                inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
                outputTokens: { reasoning: 0, text: 1, total: 1 },
              },
            },
          ];
      return {
        stream: simulateReadableStream({ chunkDelayInMs: null, chunks, initialDelayInMs: null }),
      };
    },
  });
  const tool: HostTool = {
    description: 'Perform an effect confined to this Windows fixture root',
    execute: async (input, context) => {
      const parsed = z.object({ text: z.string() }).parse(input);
      if (mode === 'approval') {
        await appendFile(join(root, 'effect-count.jsonl'), `${context.toolCallId}\n`);
        await writeFile(join(root, 'permitted.txt'), parsed.text);
        return { written: true };
      }
      const child = spawn(
        process.execPath,
        [
          ...process.execArgv,
          fileURLToPath(new URL('./windows-owned-child.ts', import.meta.url)),
          join(root, 'owned-child.json'),
        ],
        {
          signal: context.signal,
          stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
          windowsHide: true,
        }
      );
      let failure: unknown;
      const joined = new Promise<void>((resolve) => {
        child.once('error', (cause: unknown) => {
          if (!context.signal.aborted) {
            failure = cause;
          }
        });
        child.once('close', () => resolve());
      });
      const ready = (message: unknown): void => {
        const decoded = ChildReady.parse(message);
        process.send?.({ event: 'child-ready', identity: decoded.identity });
      };
      child.once('message', ready);
      await joined;
      child.off('message', ready);
      if (failure) {
        throw failure;
      }
      await writeFile(
        join(root, 'owned-child-joined.json'),
        JSON.stringify({ joined: true, pid: child.pid })
      );
      process.send?.({ event: 'child-joined', pid: child.pid });
      return { joined: true };
    },
    identity: 'windows-owned-effect-generation-1',
    inputSchema: z.object({ text: z.string() }),
    risk: mode === 'approval' ? 'edit' : 'read',
  };
  const platform: HostPlatform = {
    close: async () => undefined,
    maxSteps: 3,
    readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
    resolveModel: async (modelId) => {
      if (modelId !== 'windows-scripted') {
        throw new Error('Unknown Windows fixture model');
      }
      return model;
    },
    tools: { owned_effect: tool },
  };
  const host = await startAgentHost({ lifetime: 'persistent', root }, platform);
  try {
    process.send?.({
      event: 'ready',
      identity: Identity.parse({
        executable: process.execPath,
        pid: process.pid,
        start: processStartTime(process.pid),
      }),
      record: host.record,
    });
    await closeRequested.promise;
  } finally {
    process.off('message', control);
    await host.close();
    process.send?.({ event: 'closed' });
    if (process.connected) {
      process.disconnect();
    }
  }
}

main().catch((cause: unknown) => {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  process.send?.({ event: 'failed', message: error.message, name: error.name });
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
  if (process.connected) {
    process.disconnect();
  }
});
