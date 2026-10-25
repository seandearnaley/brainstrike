/**
 * BST-1779: the host binds every MCP tool with an inactivity budget. A call
 * that keeps reporting progress outlives its window; a silent one ends at it,
 * told it went silent. A server's configured `toolTimeoutMs` is that window.
 *
 * The guard's windows run on a fake clock: on real timers any event-loop stall
 * longer than a window ended a progressing call as silent.
 */
import { reportToolGuardActivity } from '@brainstrike/agent/tool-guard-deadline';
import { resolveScaledToolResultBudget } from '@brainstrike/agent/tool-runtime';
import type { HostToolContext } from '@brainstrike/agent-host';
import { parseConfiguredMcpServerId } from '@brainstrike/assistant-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { bindMcpTool } from '../src/mcp/mcp-tool-binding.js';

const WINDOW_MS = 80;

/** One connected server, optionally with its own configured tool window. */
function serverSnapshot(toolTimeoutMs?: number) {
  return {
    revision: 1,
    servers: [
      {
        catalog: { tools: { tools: [{ inputSchema: { type: 'object' }, name: 'work' }] } },
        configuredProtocol: 'legacy',
        configuredServerId: parseConfiguredMcpServerId('slow'),
        generation: 1,
        state: 'connected',
        ...(toolTimeoutMs === undefined ? {} : { toolTimeoutMs }),
        transport: 'stdio',
      },
    ],
  } as unknown as Parameters<typeof bindMcpTool>[0]['after'];
}

/** A bound MCP tool that runs `runMs`, reporting progress every `everyMs` (or never). */
function boundWork(runMs: number, everyMs: number | undefined, serverToolTimeoutMs?: number) {
  const snapshot = serverSnapshot(serverToolTimeoutMs);
  const source = {
    description: 'Slow work',
    execute: async (_input: unknown, context: unknown) => {
      const ticker =
        everyMs === undefined
          ? undefined
          : setInterval(() => reportToolGuardActivity(context), everyMs);
      await new Promise((resolve) => setTimeout(resolve, runMs));
      clearInterval(ticker);
      return { content: [{ text: 'done', type: 'text' }] };
    },
    id: 'slow-work',
    inputSchema: z.object({}),
  };
  return bindMcpTool({
    after: snapshot,
    before: snapshot,
    canonicalId: 'slow.work',
    resolvedToolResultBudget: resolveScaledToolResultBudget(128_000),
    runtime: { describeToolAuthority: () => ({}) as never },
    source: source as never,
    toolId: 'slow_work',
    toolTimeoutMs: WINDOW_MS,
  }).tool;
}

const context = (): HostToolContext =>
  ({
    runId: 'run-1',
    signal: new AbortController().signal,
    threadId: 'thread-1',
    toolCallId: 'call-1',
  }) as HostToolContext;

/** Runs one bound call to its end on the fake clock, `runMs` after it starts. */
async function runFor(tool: ReturnType<typeof boundWork>, runMs: number): Promise<unknown> {
  const result = Promise.resolve(tool.execute({}, context()));
  await vi.advanceTimersByTimeAsync(runMs);
  return result;
}

describe('MCP tool binding inactivity budget (BST-1779)', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'],
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lets a call that keeps reporting progress run several windows and finish', async () => {
    const tool = boundWork(WINDOW_MS * 4, 20);
    await expect(runFor(tool, WINDOW_MS * 4)).resolves.toEqual({
      content: [{ text: 'done', type: 'text' }],
    });
  });

  it("gives a silent call its server's own window, longer than the host's", async () => {
    // Silent for 2 windows, on a server configured with 4: it finishes.
    const tool = boundWork(WINDOW_MS * 2, undefined, WINDOW_MS * 4);
    await expect(runFor(tool, WINDOW_MS * 2)).resolves.toEqual({
      content: [{ text: 'done', type: 'text' }],
    });
  });

  it("ends a silent call at its server's window, naming that window", async () => {
    const tool = boundWork(WINDOW_MS * 8, undefined, WINDOW_MS * 2);
    await expect(runFor(tool, WINDOW_MS * 2)).resolves.toMatchObject({
      error: { message: expect.stringContaining(`reported no progress for ${WINDOW_MS * 2} ms`) },
    });
  });

  it('ends a silent call at its window, saying it reported no progress', async () => {
    const tool = boundWork(WINDOW_MS * 4, undefined);
    await expect(runFor(tool, WINDOW_MS)).resolves.toMatchObject({
      error: {
        code: 'tool_timeout',
        message: expect.stringContaining(`reported no progress for ${WINDOW_MS} ms`),
      },
      ok: false,
    });
  });
});
