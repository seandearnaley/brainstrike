/**
 * ADR-0015, ADR-0034: Factory Reset's archive of every managed worktree forces past ignored files
 * and leaves the worktree service making no worktree. Only Main may ask for it, over its own
 * platform connection; the desktop's client connection, which every window and Main's own client
 * share, never serves it.
 */
import { MessageChannel } from 'node:worker_threads';
import { HOST_VERSION } from '@brainstrike/host-lease';
import { afterEach, expect, test, vi } from 'vitest';
import { ErrorCodes, ResponseError } from 'vscode-jsonrpc';
import { authenticateHostClient } from '../src/client-connection.js';
import { bindHostConnection } from '../src/connection.js';
import type { HostCore } from '../src/core.js';
import type { HostGitWorkspace } from '../src/ports.js';
import { AGENT_HOST_PROTOCOL_VERSION } from '../src/protocol-version.js';
import { nodePortConnection } from '../src/transports.js';

/** Main's request on its own platform connection (`factory-reset-worktrees.ts` in the desktop). */
const RESET_ARCHIVE_METHOD = 'factory-reset/worktrees/archive';
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) {
    close();
  }
});

test("a desktop client connection does not answer Factory Reset's worktree archive", async () => {
  const archiveForReset = vi.fn(async () => ({ ok: true, value: { archived: [], retained: [] } }));
  const core = {
    hydrated: Promise.resolve(),
    liveTelemetry: { replay: () => [] },
    onCommitted: () => () => undefined,
    onTelemetry: () => () => undefined,
    published: { read: async () => [] },
    readLedger: () => ({ threads: [] }),
    releaseMcpInputClient: () => undefined,
    store: {},
    trees: { changedBy: () => undefined },
  } as unknown as HostCore;
  const gitWorkspace = {
    [RESET_ARCHIVE_METHOD]: archiveForReset,
    subscribe: () => () => undefined,
  } as unknown as HostGitWorkspace;
  const record = {
    hostVersion: HOST_VERSION,
    pid: process.pid,
    protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
    start: 'start',
  };
  const channel = new MessageChannel();
  const server = nodePortConnection(channel.port1);
  bindHostConnection(server, core, record, () => undefined, {
    gitWorkspace,
    origin: 'desktop-ui',
  });
  const raw = nodePortConnection(channel.port2);
  const closed = Promise.withResolvers<void>();
  const client = await authenticateHostClient(
    raw,
    record,
    async () => {
      channel.port2.close();
      channel.port1.close();
      server.dispose();
      closed.resolve();
    },
    closed.promise
  );
  closers.push(() => void client.close());

  const asked = raw.sendRequest(RESET_ARCHIVE_METHOD, {});

  await expect(asked).rejects.toBeInstanceOf(ResponseError);
  await expect(asked).rejects.toMatchObject({ code: ErrorCodes.MethodNotFound });
  expect(archiveForReset).not.toHaveBeenCalled();
});
