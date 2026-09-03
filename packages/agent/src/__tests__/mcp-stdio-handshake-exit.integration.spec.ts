import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExplicitStdioMcpClient } from '../mcp/explicit-stdio-client';

/**
 * BST-1600 real-transport verifier.
 *
 * Node's parent-side pipe to a child that has closed its read end accepts no
 * further writes: `write()` returns `false` and `'drain'` never fires. The
 * official SDK's `StdioClientTransport.send()` resolves only on that `'drain'`,
 * and `Client.listen()` AWAITS the send before it attaches a handler to its own
 * `opening` promise. So a stdio child that dies in that window used to
 *
 *   1. hang `subscriptions/listen` — and with it the whole connect sequence —
 *      forever, orphaning the client, and
 *   2. let `Client._onclose`'s `SdkError: Connection closed` escape as an
 *      unhandled promise rejection in Electron main.
 *
 * The fixture makes that window deterministic: it answers the session child's
 * first request normally, severs its stdin, and exits shortly after.
 */
const handshakeExitServerEntrypoint = fileURLToPath(
  new URL('../../test-fixtures/mcp-stdio-handshake-exit-server.mjs', import.meta.url)
);
const EXIT_DELAY_MS = 750;
const SETTLE_BUDGET_MS = 10_000;

interface HandshakeExitFixture {
  readonly directory: string;
  readonly env: Readonly<Record<string, string>>;
  readonly pidFile: string;
}

async function createHandshakeExitFixture(): Promise<HandshakeExitFixture> {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'agent-mcp-handshake-exit-'));
  const pidFile = path.join(directory, 'pid');
  return {
    directory,
    env: {
      BRAINSTRIKE_STDIO_HANDSHAKE_EXIT_CODE: '7',
      BRAINSTRIKE_STDIO_HANDSHAKE_EXIT_DELAY_MS: String(EXIT_DELAY_MS),
      BRAINSTRIKE_STDIO_HANDSHAKE_PID_FILE: pidFile,
      // The session child's first outbound message is its `tools/list` result:
      // modern era needs no `initialize`, and the `server/discover` probe runs
      // on a separate sibling child.
      BRAINSTRIKE_STDIO_HANDSHAKE_SEVER_AFTER_RESPONSES: '1',
    },
    pidFile,
  };
}

/**
 * The session child writes this file before it serves; the disposable
 * version-negotiation sibling writes it first and is overwritten.
 */
async function readFixturePid(pidFile: string): Promise<number> {
  const raw = await fsp.readFile(pidFile, 'utf8');
  expect(raw).toMatch(/^[1-9]\d*\n$/u);
  return Number.parseInt(raw, 10);
}

async function settleWithin<T>(work: Promise<T>, label: string): Promise<T | string> {
  return await Promise.race([
    work.then(
      () => `${label}:resolved`,
      (cause: unknown) => `${label}:rejected:${(cause as Error)?.message ?? String(cause)}`
    ),
    new Promise<string>((resolve) => {
      setTimeout(() => resolve(`${label}:never-settled`), SETTLE_BUDGET_MS);
    }),
  ]);
}

describe('stdio child that dies mid-handshake', () => {
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

  it('settles subscriptions/listen instead of hanging on the severed pipe', async () => {
    const fixture = await createHandshakeExitFixture();
    const client = new ExplicitStdioMcpClient({
      args: [handshakeExitServerEntrypoint],
      command: process.execPath,
      env: fixture.env,
      name: 'handshake-exit',
      protocol: '2026-07-28',
    });
    try {
      await client.connect({ timeout: 10_000 });
      // The one answered request; the child severs its stdin right after it.
      await expect(client.listTools()).resolves.toMatchObject({
        tools: [expect.objectContaining({ name: 'handshake_probe' })],
      });
      const childPid = await readFixturePid(fixture.pidFile);

      const outcome = await settleWithin(
        client.listen({ toolsListChanged: true }, { timeout: 10_000 }),
        'listen'
      );
      // Node reports an unhandled rejection after the microtask queue drains,
      // so give it a turn before asserting there was none.
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(rejections.map((reason) => `${(reason as Error)?.message}`)).toEqual([]);
      // The failure is surfaced and settled, never hung and never swallowed
      // into a silent no-subscription success.
      expect(outcome).toMatch(/^listen:rejected:/u);

      // Terminal closure reaps the child instead of orphaning it behind a write
      // that can never drain.
      await client.close();
      expect(() => process.kill(childPid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    } finally {
      await client.close().catch(() => undefined);
      await fsp.rm(fixture.directory, { force: true, recursive: true });
    }
  }, 40_000);
});
