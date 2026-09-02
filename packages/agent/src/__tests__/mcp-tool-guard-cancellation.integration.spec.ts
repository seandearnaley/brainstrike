import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type McpHostPort, parseConfiguredMcpServerId } from '@brainstrike/assistant-contract';
import { describe, expect, it } from 'vitest';
import { createMcpRuntimeClient } from '../mastra/mcp-runtime-client';
import { ExplicitStdioMcpClient } from '../mcp/explicit-stdio-client';
import {
  applyToolGuards,
  type GuardedToolError,
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
 * (`createMcpRuntimeClient` → Mastra `createTool` → `applyToolGuards`), so the
 * guard's deadline has to survive Mastra's execution-context reconstruction to
 * reach the in-flight request.
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
 * The stdio slice of the desktop host's `tools/call` contract: `onprogress`,
 * the merged signal, and `resetTimeoutOnProgress: true` — the flag that makes
 * an abandoned progress-emitting call outlive its guard.
 */
function createStdioMcpHost(
  name: string,
  args: readonly string[],
  env: Record<string, string>
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
    async invoke(operation, options) {
      if (operation.configuredServerId !== configuredServerId) {
        throw new Error(`Unexpected MCP server id: ${operation.configuredServerId}`);
      }
      const requestOptions = {
        ...(options?.onProgress ? { onprogress: options.onProgress } : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
      };
      if (operation.type === 'tools/list') {
        return { result: await client.listTools(requestOptions), type: operation.type };
      }
      if (operation.type !== 'tools/call') {
        throw new Error(`Unexpected MCP operation: ${operation.type}`);
      }
      return {
        result: await client.callTool(
          {
            ...(operation.arguments ? { arguments: operation.arguments } : {}),
            name: operation.toolName,
          },
          { ...requestOptions, resetTimeoutOnProgress: true }
        ),
        type: operation.type,
      };
    },
    replaceConfig: async () => {
      throw new Error('Test MCP host config is immutable');
    },
    snapshot: () => snapshot,
    watch: () => () => undefined,
  };
}

describe('MCP tool guard cancellation over a real stdio transport', () => {
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
          agent: { toolCallId: 'guard-cancellation-call' },
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
