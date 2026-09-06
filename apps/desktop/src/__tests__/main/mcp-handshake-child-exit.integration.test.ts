import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfiguredMcpServerId } from '@brainstrike/assistant-contract';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createDesktopMcpHostRuntime } from '../../mcp/host-runtime';

/**
 * BST-1600 real-transport verifier.
 *
 * A misconfigured MCP server (wrong command, missing package, bad path) is what
 * a new user has on first run, and it is exactly the case that kills the stdio
 * child while the host is still handshaking. That must read as an ordinary
 * lifecycle failure on the server row — never an unhandled promise rejection in
 * Electron main, and never a hung connect that outlives main's 5s
 * `SIGNAL_SHUTDOWN_TIMEOUT_MS` graceful-shutdown budget.
 *
 * The fixture makes the window deterministic: the session child answers the
 * host's `tools/list`, severs its own stdin (so the parent pipe accepts no
 * further writes and never drains), and exits shortly after — while the host's
 * `subscriptions/listen` write is still outstanding.
 */
const handshakeExitServerEntrypoint = fileURLToPath(
  import.meta.resolve('@brainstrike/agent/test-fixtures/mcp-stdio-handshake-exit-server.mjs')
);
const CONNECT_BUDGET_MS = 20_000;
/** main.ts `SIGNAL_SHUTDOWN_TIMEOUT_MS`: the budget a hung client would blow. */
const GRACEFUL_SHUTDOWN_BUDGET_MS = 5000;

describe('MCP stdio child that exits mid-handshake', () => {
  const rejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown): void => {
    rejections.push(reason);
  };

  beforeEach(() => {
    rejections.length = 0;
    process.on('unhandledRejection', onUnhandledRejection);
  });

  afterEach(() => {
    process.off('unhandledRejection', onUnhandledRejection);
  });

  test('fails the server row without an unhandled rejection or a hung shutdown', async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'desktop-mcp-handshake-exit-'));
    const pidFile = path.join(directory, 'pid');
    const configuredServerId = parseConfiguredMcpServerId('stdio.handshake-exit');
    const runtime = createDesktopMcpHostRuntime();
    try {
      await runtime.replaceResolvedConfig({
        servers: [
          {
            args: [handshakeExitServerEntrypoint],
            command: process.execPath,
            env: {
              BRAINSTRIKE_STDIO_HANDSHAKE_EXIT_CODE: '7',
              BRAINSTRIKE_STDIO_HANDSHAKE_EXIT_DELAY_MS: '750',
              BRAINSTRIKE_STDIO_HANDSHAKE_PID_FILE: pidFile,
              BRAINSTRIKE_STDIO_HANDSHAKE_SEVER_AFTER_RESPONSES: '1',
            },
            name: configuredServerId,
            protocol: '2026-07-28',
            startup: 'automatic',
            transport: 'stdio',
          },
        ],
      });

      const connectOutcome = await Promise.race([
        runtime.host.control({ action: 'connect', configuredServerId }).then(
          (snapshot) => `settled:${snapshot.state}`,
          (cause: unknown) => `settled:rejected:${(cause as Error)?.message ?? String(cause)}`
        ),
        new Promise<string>((resolve) => {
          setTimeout(() => resolve('never-settled'), CONNECT_BUDGET_MS);
        }),
      ]);
      // Node reports an unhandled rejection once the microtask queue drains.
      await new Promise((resolve) => setTimeout(resolve, 250));

      expect(rejections.map((reason) => `${(reason as Error)?.message}`)).toEqual([]);
      expect(connectOutcome).toMatch(/^settled:/u);
      expect(runtime.host.snapshot().servers[0]).toMatchObject({
        configuredServerId,
        error: { category: 'connection', code: 'mcp-child-exited' },
        state: 'error',
      });

      // The client is owned, not orphaned: teardown finishes inside main's
      // forced-exit budget instead of holding it open.
      const closeStartedAt = Date.now();
      await expect(runtime.host.close()).resolves.toMatchObject({ failures: [] });
      expect(Date.now() - closeStartedAt).toBeLessThan(GRACEFUL_SHUTDOWN_BUDGET_MS);
      // …and the child it owned is gone, not left behind by a client the actor
      // dropped when it rethrew the recorded failure.
      const childPid = await fsp.readFile(pidFile, 'utf8');
      expect(childPid).toMatch(/^[1-9]\d*\n$/u);
      expect(() => process.kill(Number.parseInt(childPid, 10), 0)).toThrow(
        expect.objectContaining({ code: 'ESRCH' })
      );
    } finally {
      await runtime.host.close().catch(() => undefined);
      await fsp.rm(directory, { force: true, recursive: true });
    }
  }, 60_000);
});
