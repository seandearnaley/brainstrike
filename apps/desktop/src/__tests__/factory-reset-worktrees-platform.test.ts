// @vitest-environment node

/**
 * ADR-0015, ADR-0034: Factory Reset's archive of every managed worktree reaches the host only on
 * Main's private platform connection, the one Main's MCP retire for the reset already uses. No
 * window holds that connection, so no window can ask for it.
 */
import { EventEmitter } from 'node:events';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { expect, it, vi } from 'vitest';
import {
  mainPlatformConnection,
  type PlatformMessagePort,
} from '../agent-host-platform/connection';
import {
  createMainWorktreeReset,
  serveWorktreeResetToMain,
} from '../agent-host-platform/factory-reset-worktrees';
import { serveDesktopPlatform } from '../agent-host-platform/main-platform';
import { createDesktopMcpPlatformCapabilities } from '../mcp/desktop-host-platform';
import { MainMcpHostControl } from '../mcp/main-host-control';
import { mainReads } from './fixtures/desktop-admission-reads';

/** Real Node ports with the Electron utility port's public MessageEvent shape. */
class UtilityPort extends EventEmitter implements PlatformMessagePort {
  private readonly port: MessagePort;

  constructor(port: MessagePort) {
    super();
    this.port = port;
    port.on('message', (data: unknown) => this.emit('message', { data }));
    port.on('close', () => this.emit('close'));
  }
  start(): void {
    this.port.start();
  }
  postMessage(message: unknown): void {
    this.port.postMessage(message);
  }
  close(): void {
    this.port.close();
  }
}

const ARCHIVE = {
  ok: true,
  value: {
    archived: [
      {
        path: '/home/tester/.brainstrike/worktrees/app/swift-badger',
        snapshotRef: 'refs/brainstrike/worktree-archive/wt-1',
        worktreeId: 'wt-1',
      },
    ],
    retained: [
      {
        code: 'worktree.locked',
        path: '/home/tester/.brainstrike/worktrees/app/calm-otter',
        reason: 'This worktree is locked.',
        worktreeId: 'wt-2',
      },
    ],
  },
} as const;

/** Main serves its platform to a host connection whose host serves the reset's archive. */
function connect() {
  const channel = new MessageChannel();
  const mainPort = new UtilityPort(channel.port1);
  const hostPort = new UtilityPort(channel.port2);
  const reset = createMainWorktreeReset();
  const main = mainPlatformConnection(mainPort);
  const owner = serveDesktopPlatform(main, {
    admission: mainReads(),
    mcp: createDesktopMcpPlatformCapabilities(new MainMcpHostControl()),
    worktreeReset: reset,
  });
  const host = mainPlatformConnection(hostPort);
  const archive = vi.fn(async () => ARCHIVE);
  serveWorktreeResetToMain(host, archive);
  host.listen();
  return {
    archive,
    destroy: () => {
      host.dispose();
      main.dispose();
      mainPort.close();
      hostPort.close();
    },
    host,
    owner,
    reset,
  };
}

it("asks the host it launched for the archive on Main's own connection, once the host confirmed Main ready", async () => {
  const f = connect();
  try {
    await expect(f.reset.archive()).resolves.toMatchObject({
      error: { category: 'availability', code: 'host.not-ready', kind: 'refusal' },
      ok: false,
    });
    expect(f.archive).not.toHaveBeenCalled();

    await f.host.sendRequest('platform/ready', {});

    await expect(f.reset.archive()).resolves.toEqual(ARCHIVE);
    expect(f.archive).toHaveBeenCalledTimes(1);
  } finally {
    f.destroy();
  }
});

it('refuses once the host connection it was asking has closed', async () => {
  const f = connect();
  try {
    await f.host.sendRequest('platform/ready', {});
    await f.owner.close();

    await expect(f.reset.archive()).resolves.toMatchObject({
      error: { code: 'host.not-ready', kind: 'refusal' },
      ok: false,
    });
    expect(f.archive).not.toHaveBeenCalled();
  } finally {
    f.destroy();
  }
});
