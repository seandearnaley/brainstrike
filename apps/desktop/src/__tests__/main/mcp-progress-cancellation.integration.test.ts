import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfiguredMcpServerId } from '@brainstrike/assistant-contract';
import { describe, expect, test } from 'vitest';
import { createDesktopMcpHostRuntime } from '../../mcp/host-runtime';

/**
 * BST-1594 real-transport verifier.
 *
 * `tools/call` is issued with `resetTimeoutOnProgress: true`, so a server that
 * keeps emitting progress can defer the SDK's 60s request timeout all the way
 * to the 10 minute absolute bound. When the caller (the per-tool execution
 * guard, upstream in `@brainstrike/agent`) gives up, the request must be
 * CANCELLED rather than abandoned, and cancelling one call must not retire the
 * server generation.
 *
 * The proof runs over a real spawned stdio child: the fixture records the
 * `notifications/cancelled` the SDK sends, and the same connection keeps
 * serving afterwards.
 */
const progressServerEntrypoint = fileURLToPath(
  import.meta.resolve('@brainstrike/agent/test-fixtures/mcp-stdio-progress-cancellation-server.mjs')
);

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

describe('MCP progress-deferred tool call cancellation', () => {
  test('cancels the dangling host request and keeps the server generation connected', async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'desktop-mcp-progress-cancel-'));
    const stateFile = path.join(directory, 'state.json');
    const configuredServerId = parseConfiguredMcpServerId('stdio.progress');
    const runtime = createDesktopMcpHostRuntime();
    try {
      await runtime.replaceResolvedConfig({
        servers: [
          {
            args: [progressServerEntrypoint],
            command: process.execPath,
            env: {
              BRAINSTRIKE_STDIO_PROGRESS_INTERVAL_MS: '25',
              BRAINSTRIKE_STDIO_PROGRESS_STATE_FILE: stateFile,
            },
            name: configuredServerId,
            protocol: 'legacy',
            startup: 'automatic',
            transport: 'stdio',
          },
        ],
      });

      const abandoned = new AbortController();
      const cancellation = new Error('tool guard abandoned the MCP call');
      const observedProgress: number[] = [];
      const call = runtime.host.invoke(
        { configuredServerId, toolName: 'progress_forever', type: 'tools/call' },
        {
          onProgress: ({ progress }) => {
            observedProgress.push(progress);
            // Stand in for the guard giving up while the server is still
            // pushing progress — the exact moment the request would otherwise
            // be left open for the remaining absolute budget.
            abandoned.abort(cancellation);
          },
          signal: abandoned.signal,
        }
      );

      await expect(call).rejects.toBe(cancellation);
      expect(observedProgress.length).toBeGreaterThan(0);

      // The server observed the client's `notifications/cancelled` — the
      // request was cancelled on the wire, not merely dropped by the caller.
      await expect
        .poll(async () => (await readFixtureState(stateFile)).cancelled, { timeout: 10_000 })
        .toBe(true);
      expect((await readFixtureState(stateFile)).progressSent).toBeGreaterThan(0);

      // ...and the generation survived the abandoned call.
      expect(runtime.host.snapshot().servers[0]).toMatchObject({
        configuredServerId,
        state: 'connected',
      });
      await expect(
        runtime.host.invoke({ configuredServerId, type: 'tools/list' })
      ).resolves.toMatchObject({
        result: {
          tools: expect.arrayContaining([expect.objectContaining({ name: 'progress_forever' })]),
        },
        type: 'tools/list',
      });
      expect(runtime.host.snapshot().servers[0]).toMatchObject({ state: 'connected' });
    } finally {
      await runtime.host.close();
      await fsp.rm(directory, { force: true, recursive: true });
    }
  }, 30_000);
});
