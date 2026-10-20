import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type GuardedToolError,
  type McpHostPort,
  parseConfiguredMcpServerId,
} from '@brainstrike/assistant-contract';
import { parseMcpHostOperationResult } from '@brainstrike/assistant-contract/mcp-host-runtime';
import { afterAll, describe, expect, it } from 'vitest';
import type { HostToolExecutionContext } from '../host-tool-definition';
import { DEFAULT_MCP_MAX_TOTAL_TIMEOUT_MS } from '../mcp/client-policy';
import { ExplicitStdioMcpClient } from '../mcp/explicit-stdio-client';
import { createMcpRuntimeClient } from '../mcp/mcp-runtime-client';
import {
  applyToolGuards,
  guardToolExecution,
  isGuardedToolError,
} from '../tools/guard-tool-execution';

/**
 * BST-1594 real-transport verifier.
 *
 * The host issues every `tools/call` with `resetTimeoutOnProgress: true`, so a
 * server that keeps emitting progress defers the SDK's request timeout for as
 * long as it keeps talking. The per-tool execution guard answers the model at
 * its own deadline, and BEFORE this fix that answer abandoned the request
 * rather than cancelling it: the server was never told, and the POST stayed
 * open until the absolute bound.
 *
 * This spec spawns a real stdio child that streams progress until it is
 * cancelled and records whether it observed the client's
 * `notifications/cancelled`. The tool is driven through the production path
 * (`createMcpRuntimeClient` → host producer → `applyToolGuards`), retaining
 * the host context's identity and physical cancellation signal.
 */
const progressServerEntrypoint = fileURLToPath(
  new URL('../../test-fixtures/mcp-stdio-progress-cancellation-server.mjs', import.meta.url)
);
const GUARD_TIMEOUT_MS = 400;

interface ProgressFixtureState {
  readonly cancelled: boolean;
  readonly progressSent: number;
}

async function readFixtureState(stateFile: string): Promise<ProgressFixtureState> {
  const raw: unknown = JSON.parse(await fsp.readFile(stateFile, 'utf8'));
  if (
    !(raw && typeof raw === 'object') ||
    typeof (raw as ProgressFixtureState).cancelled !== 'boolean' ||
    !Number.isSafeInteger((raw as ProgressFixtureState).progressSent)
  ) {
    throw new Error('Progress cancellation fixture wrote an unreadable state file');
  }
  return raw as ProgressFixtureState;
}

/**
 * The host's request timeouts for a `tools/call` (core-server-features): a call
 * whose guard owns inactivity keeps only the total; any other keeps the SDK's
 * idle timeout, which `sdkIdleTimeoutMs` scales down from its 60 s default.
 */
function requestTimeouts(
  options: Parameters<McpHostPort['invoke']>[1],
  sdkIdleTimeoutMs: number | undefined
): { readonly maxTotalTimeout?: number; readonly timeout?: number } {
  if (options?.callerGuardsInactivity) {
    return {
      maxTotalTimeout: DEFAULT_MCP_MAX_TOTAL_TIMEOUT_MS,
      timeout: DEFAULT_MCP_MAX_TOTAL_TIMEOUT_MS,
    };
  }
  return sdkIdleTimeoutMs === undefined ? {} : { timeout: sdkIdleTimeoutMs };
}

/**
 * The stdio slice of the desktop host's `tools/call` contract: `onprogress`,
 * the merged signal, and `resetTimeoutOnProgress: true` — the flag that makes
 * an abandoned progress-emitting call outlive its guard.
 */
function createStdioMcpHost(
  name: string,
  args: readonly string[],
  env: Record<string, string>,
  sdkIdleTimeoutMs?: number
): McpHostPort {
  const configuredServerId = parseConfiguredMcpServerId(name);
  const client = new ExplicitStdioMcpClient({ args, command: process.execPath, env, name });
  const snapshot = {
    revision: 1,
    servers: [
      {
        configuredProtocol: 'legacy' as const,
        configuredServerId,
        generation: 1,
        state: 'disconnected' as const,
        transport: 'stdio' as const,
      },
    ],
  };
  return {
    async close() {
      await client.close();
      return {
        callbacksClosed: 0,
        childProcessesClosed: 1,
        clientsClosed: 1,
        failures: [],
        loopbackPortsClosed: 0,
        probesClosed: 0,
        requestsSettled: 0,
        subscriptionsClosed: 0,
      };
    },
    control: async () => {
      throw new Error('Test MCP host controls are not supported');
    },
    async invoke(operation, options) {
      if (operation.configuredServerId !== configuredServerId) {
        throw new Error(`Unexpected MCP server id: ${operation.configuredServerId}`);
      }
      const requestOptions = {
        ...(options?.onProgress ? { onprogress: options.onProgress } : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
      };
      if (operation.type === 'tools/list') {
        return parseMcpHostOperationResult({
          result: await client.listTools(requestOptions),
          type: operation.type,
        });
      }
      if (operation.type !== 'tools/call') {
        throw new Error(`Unexpected MCP operation: ${operation.type}`);
      }
      return parseMcpHostOperationResult({
        result: await client.callTool(
          {
            ...(operation.arguments ? { arguments: operation.arguments } : {}),
            name: operation.toolName,
          },
          {
            ...requestOptions,
            ...requestTimeouts(options, sdkIdleTimeoutMs),
            resetTimeoutOnProgress: true,
          }
        ),
        type: operation.type,
      });
    },
    replaceConfig: async () => {
      throw new Error('Test MCP host config is immutable');
    },
    snapshot: () => snapshot,
    watch: () => () => undefined,
  };
}

describe('MCP tool guard cancellation over a real stdio transport', () => {
  it('cancels only the timed-out occurrence when concurrent runs reuse a provider ID', async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'agent-mcp-concurrent-cancel-'));
    const stateFile = path.join(directory, 'state.json');
    const host = createStdioMcpHost('progress', [progressServerEntrypoint], {
      BRAINSTRIKE_STDIO_PROGRESS_INTERVAL_MS: '25',
      BRAINSTRIKE_STDIO_PROGRESS_STATE_FILE: stateFile,
    });
    const callerA = new AbortController();
    const callerB = new AbortController();
    const lookup = Promise.withResolvers<void>();
    const progressA = Promise.withResolvers<void>();
    const progressB = Promise.withResolvers<void>();
    let writesB = 0;
    const runtimeClient = await createMcpRuntimeClient({ config: undefined, host });
    let first: Promise<unknown> | undefined;
    let second: Promise<unknown> | undefined;
    try {
      const discovered = await runtimeClient?.listToolsetsWithErrors();
      expect(discovered?.errors).toEqual({});
      const source = discovered?.toolsets['progress']?.['progress_forever'];
      if (!source || typeof source.execute !== 'function') {
        throw new Error('Progress fixture has no executable producer');
      }
      const execute = source.execute;
      const delayed = {
        ...source,
        execute: async (input: unknown, context?: HostToolExecutionContext): Promise<unknown> => {
          await lookup.promise;
          return await Reflect.apply(execute, source, [input, context]);
        },
      };
      const toolA = guardToolExecution(delayed, {
        timeoutMs: GUARD_TIMEOUT_MS,
        toolName: 'progress-a',
      });
      const toolB = guardToolExecution(delayed, { timeoutMs: 5000, toolName: 'progress-b' });
      first = toolA.execute(
        {},
        {
          abortSignal: callerA.signal,
          runId: 'root-run',
          threadId: 'root-thread',
          toolCallId: 'call_1',
          writer: {
            custom: async () => {
              progressA.resolve();
            },
          },
        }
      );
      second = toolB.execute(
        {},
        {
          abortSignal: callerB.signal,
          runId: 'child-run',
          threadId: 'child-thread',
          toolCallId: 'call_1',
          writer: {
            custom: async () => {
              writesB += 1;
              progressB.resolve();
            },
          },
        }
      );
      lookup.resolve();
      await Promise.all([progressA.promise, progressB.promise]);
      await expect(first).resolves.toMatchObject({ error: { code: 'tool_timeout' }, ok: false });
      await expect.poll(async () => (await readFixtureState(stateFile)).cancelled).toBe(true);
      const before = writesB;
      await expect.poll(() => writesB).toBeGreaterThan(before);
      expect(callerA.signal.aborted).toBe(false);
      expect(callerB.signal.aborted).toBe(false);
      const listed = await host.invoke({
        configuredServerId: parseConfiguredMcpServerId('progress'),
        type: 'tools/list',
      });
      expect(listed.type).toBe('tools/list');
      // The fixture publishes one terminal receipt into an absent destination.
      // Remove the first before independently stopping the still-active sibling.
      await fsp.unlink(stateFile);
      callerB.abort(new Error('Stop only the sibling'));
      await expect(second).resolves.toMatchObject({ error: { code: 'tool_failed' }, ok: false });
      await expect.poll(async () => (await readFixtureState(stateFile)).cancelled).toBe(true);
    } finally {
      lookup.resolve();
      callerA.abort();
      callerB.abort();
      await runtimeClient?.disconnect();
      await host.close();
      await Promise.all([first, second]);
      await fsp.rm(directory, { force: true, recursive: true });
    }
  }, 30_000);

  it('cancels the progress-deferred request on the wire when the guard gives up', async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'agent-mcp-progress-cancel-'));
    const stateFile = path.join(directory, 'state.json');
    const host = createStdioMcpHost('progress', [progressServerEntrypoint], {
      BRAINSTRIKE_STDIO_PROGRESS_INTERVAL_MS: '25',
      BRAINSTRIKE_STDIO_PROGRESS_STATE_FILE: stateFile,
    });
    try {
      const runtimeClient = await createMcpRuntimeClient({ config: undefined, host });
      const discovered = await runtimeClient?.listToolsetsWithErrors();
      expect(discovered?.errors).toEqual({});
      const guarded = applyToolGuards(discovered?.toolsets['progress'] ?? {}, {
        timeoutMs: GUARD_TIMEOUT_MS,
      });
      const tool = guarded['progress_forever'] as {
        execute: (input: unknown, context: unknown) => Promise<unknown>;
      };

      const run = new AbortController();
      const result = (await tool.execute(
        {},
        {
          abortSignal: run.signal,
          toolCallId: 'guard-cancellation-call',
          writer: { custom: async () => undefined },
        }
      )) as GuardedToolError;

      expect(isGuardedToolError(result)).toBe(true);
      expect(result.error.code).toBe('tool_timeout');
      // The run itself was never cancelled — only the guarded call was.
      expect(run.signal.aborted).toBe(false);

      // The server observed the client's `notifications/cancelled`, so the
      // request was withdrawn on the wire rather than left dangling.
      await expect
        .poll(async () => (await readFixtureState(stateFile)).cancelled, { timeout: 10_000 })
        .toBe(true);
      expect((await readFixtureState(stateFile)).progressSent).toBeGreaterThan(0);

      await runtimeClient?.disconnect();
    } finally {
      await host.close();
      await fsp.rm(directory, { force: true, recursive: true });
    }
  }, 30_000);
});

/**
 * BST-1779 over the same real transport: an MCP call's progress restarts its
 * guard window (an inactivity budget, as the host binds MCP tools), bounded by
 * a total budget. Times are scaled down: a 400 ms window stands in for 60 s.
 */
describe('MCP inactivity budget over a real stdio transport (BST-1779)', () => {
  async function runGuarded(
    env: Record<string, string>,
    maxTotalMs: number,
    awaitCancellation = false,
    sdkIdleTimeoutMs?: number
  ): Promise<{ readonly result: unknown }> {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'agent-mcp-inactivity-'));
    const stateFile = path.join(directory, 'state.json');
    const host = createStdioMcpHost(
      'progress',
      [progressServerEntrypoint],
      {
        BRAINSTRIKE_STDIO_PROGRESS_INTERVAL_MS: '50',
        BRAINSTRIKE_STDIO_PROGRESS_STATE_FILE: stateFile,
        ...env,
      },
      sdkIdleTimeoutMs
    );
    const runtimeClient = await createMcpRuntimeClient({ config: undefined, host });
    try {
      const discovered = await runtimeClient?.listToolsetsWithErrors();
      const source = discovered?.toolsets['progress']?.['progress_forever'];
      if (!source) {
        throw new Error('Progress fixture has no executable producer');
      }
      const tool = guardToolExecution(source, {
        activity: { maxTotalMs },
        timeoutMs: GUARD_TIMEOUT_MS,
        toolName: 'progress',
      }) as { execute: (input: unknown, context: unknown) => Promise<unknown> };
      const result = await tool.execute(
        {},
        { abortSignal: new AbortController().signal, toolCallId: 'inactivity-call' }
      );
      if (awaitCancellation) {
        // The server was told: notifications/cancelled reached it.
        await expect
          .poll(async () => (await readFixtureState(stateFile)).cancelled, { timeout: 10_000 })
          .toBe(true);
      }
      return { result };
    } finally {
      await runtimeClient?.disconnect();
      await host.close();
      cleanups.push(() => fsp.rm(directory, { force: true, recursive: true }));
    }
  }
  const cleanups: (() => Promise<void>)[] = [];
  afterAll(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup();
    }
  });

  it('lets a call that keeps reporting progress run past its window and finish', async () => {
    // Progress every 50 ms for 1.2 s: three times the 400 ms window, no gap longer than it.
    const { result } = await runGuarded(
      { BRAINSTRIKE_STDIO_PROGRESS_FINISH_AFTER_MS: '1200' },
      10_000
    );
    expect(isGuardedToolError(result)).toBe(false);
    expect(JSON.stringify(result)).toContain('finished');
  }, 30_000);

  it('cancels a silent call at its window, on the wire, naming the silence', async () => {
    const { result } = await runGuarded(
      {
        BRAINSTRIKE_STDIO_PROGRESS_FINISH_AFTER_MS: '5000',
        BRAINSTRIKE_STDIO_PROGRESS_SILENT: '1',
      },
      10_000,
      true
    );
    expect(result).toMatchObject({
      error: {
        code: 'tool_timeout',
        message: expect.stringContaining('reported no progress for 400 ms'),
      },
      ok: false,
    });
  }, 30_000);

  it('ends a call that goes silent mid-work at its guard window, not the SDK request timeout', async () => {
    // The SDK's idle timeout equals the guard window, as in production (60 s
    // each), and re-arms on progress before the guard does: unless it stands
    // back, it ends the call first, as a failure the model cannot read.
    const { result } = await runGuarded(
      {
        BRAINSTRIKE_STDIO_PROGRESS_FINISH_AFTER_MS: '5000',
        BRAINSTRIKE_STDIO_PROGRESS_SILENT_AFTER_MS: '600',
      },
      10_000,
      true,
      GUARD_TIMEOUT_MS
    );
    expect(result).toMatchObject({
      error: {
        code: 'tool_timeout',
        message: expect.stringContaining('reported no progress for 400 ms'),
      },
      ok: false,
    });
  }, 30_000);

  it('cancels a call that reports progress forever at its total budget, on the wire', async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'agent-mcp-total-'));
    const stateFile = path.join(directory, 'state.json');
    const host = createStdioMcpHost('progress', [progressServerEntrypoint], {
      BRAINSTRIKE_STDIO_PROGRESS_INTERVAL_MS: '50',
      BRAINSTRIKE_STDIO_PROGRESS_STATE_FILE: stateFile,
    });
    const runtimeClient = await createMcpRuntimeClient({ config: undefined, host });
    try {
      const discovered = await runtimeClient?.listToolsetsWithErrors();
      const source = discovered?.toolsets['progress']?.['progress_forever'];
      if (!source) {
        throw new Error('Progress fixture has no executable producer');
      }
      const tool = guardToolExecution(source, {
        activity: { maxTotalMs: 1500 },
        timeoutMs: GUARD_TIMEOUT_MS,
        toolName: 'progress',
      }) as { execute: (input: unknown, context: unknown) => Promise<unknown> };
      const startedAt = performance.now();
      const result = await tool.execute(
        {},
        { abortSignal: new AbortController().signal, toolCallId: 'total-call' }
      );
      expect(performance.now() - startedAt).toBeGreaterThanOrEqual(1400);
      expect(result).toMatchObject({
        error: {
          code: 'tool_timeout',
          message: expect.stringContaining('did not finish within its 1500 ms total budget'),
        },
        ok: false,
      });
      // The server was told: notifications/cancelled reached it.
      await expect
        .poll(async () => (await readFixtureState(stateFile)).cancelled, { timeout: 10_000 })
        .toBe(true);
    } finally {
      await runtimeClient?.disconnect();
      await host.close();
      await fsp.rm(directory, { force: true, recursive: true });
    }
  }, 30_000);
});
