import { EventEmitter } from 'node:events';
import type { App } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import {
  installMcpAppsSandboxStartup,
  MCP_APP_SANDBOX_PARTITION,
} from '../../mcp/apps-sandbox-startup';

class FakeSession extends EventEmitter {
  readonly clearCache = vi.fn(async () => undefined);
  readonly clearStorageData = vi.fn(async () => undefined);
  readonly setPermissionCheckHandler = vi.fn();
  readonly setPermissionRequestHandler = vi.fn();
}

class FakeWebContents extends EventEmitter {
  private destroyed = false;
  readonly setWindowOpenHandler = vi.fn();

  constructor(readonly session: FakeSession) {
    super();
  }

  close(): void {
    this.destroyed = true;
    this.emit('destroyed', {});
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }
}

function setup() {
  const app = new EventEmitter();
  const appSession = new FakeSession();
  const defaultSession = new FakeSession();
  const sessions = {
    defaultSession,
    fromPartition: vi.fn((partition: string) => {
      if (partition !== MCP_APP_SANDBOX_PARTITION) {
        throw new Error(`unexpected partition ${partition}`);
      }
      return appSession;
    }),
  };
  const teardownErrors: unknown[] = [];
  const close = installMcpAppsSandboxStartup({
    app: app as unknown as App,
    onTeardownError: (error) => teardownErrors.push(error),
    resolveSessions: () => sessions,
  });
  return { app, appSession, close, defaultSession, sessions, teardownErrors };
}

describe('installMcpAppsSandboxStartup', () => {
  it('boots without touching the session module, even when fromPartition is absent', () => {
    const app = new EventEmitter();
    const sessions = { defaultSession: new FakeSession() };
    const resolveSessions = vi.fn(
      () =>
        sessions as unknown as ReturnType<
          Parameters<typeof installMcpAppsSandboxStartup>[0]['resolveSessions']
        >
    );
    const close = installMcpAppsSandboxStartup({
      app: app as unknown as App,
      onTeardownError: () => undefined,
      resolveSessions,
    });
    // Boot-time doubles (main boot tests) may expose no `session` export at all.
    expect(resolveSessions).not.toHaveBeenCalled();
    expect(app.listenerCount('web-contents-created')).toBe(1);

    // The host window (default session) never triggers partition resolution.
    app.emit('web-contents-created', {}, new FakeWebContents(sessions.defaultSession));
    expect(resolveSessions).toHaveBeenCalledTimes(1);
    expect(sessions.defaultSession.setPermissionCheckHandler).not.toHaveBeenCalled();

    return close();
  });

  it('never resolves the sandbox partition for the default session', () => {
    const { app, defaultSession, sessions } = setup();
    const mainContents = new FakeWebContents(defaultSession);

    app.emit('web-contents-created', {}, mainContents);

    expect(sessions.fromPartition).not.toHaveBeenCalled();
    expect(defaultSession.setPermissionCheckHandler).not.toHaveBeenCalled();
    expect(mainContents.setWindowOpenHandler).not.toHaveBeenCalled();
  });

  it('resolves the partition on demand and skips other non-default sessions', () => {
    const { app, sessions } = setup();
    const otherSession = new FakeSession();
    const otherContents = new FakeWebContents(otherSession);

    app.emit('web-contents-created', {}, otherContents);
    app.emit('web-contents-created', {}, new FakeWebContents(otherSession));

    // Memoized: one resolution serves every later comparison.
    expect(sessions.fromPartition).toHaveBeenCalledTimes(1);
    expect(otherSession.setPermissionCheckHandler).not.toHaveBeenCalled();
    expect(otherContents.setWindowOpenHandler).not.toHaveBeenCalled();
  });

  it('installs exactly once on the first mcp-app WebContents and tears down on destroy', async () => {
    const { app, appSession, close, defaultSession, sessions, teardownErrors } = setup();
    const mainContents = new FakeWebContents(defaultSession);
    const appContents = new FakeWebContents(appSession);

    app.emit('web-contents-created', {}, mainContents);
    app.emit('web-contents-created', {}, appContents);
    app.emit('web-contents-created', {}, appContents);

    // One lazy resolution plus one inside the policy install; never at boot.
    expect(sessions.fromPartition.mock.calls).toEqual([
      [MCP_APP_SANDBOX_PARTITION, { cache: false }],
      [MCP_APP_SANDBOX_PARTITION, { cache: false }],
    ]);
    expect(defaultSession.setPermissionCheckHandler).not.toHaveBeenCalled();
    expect(mainContents.setWindowOpenHandler).not.toHaveBeenCalled();
    expect(appSession.setPermissionCheckHandler).toHaveBeenCalledTimes(1);
    expect(appContents.setWindowOpenHandler).toHaveBeenCalledTimes(1);

    appContents.close();
    await Promise.resolve();
    await close();
    expect(teardownErrors).toEqual([]);
    expect(app.listenerCount('web-contents-created')).toBe(0);
    expect(appContents.listenerCount('destroyed')).toBe(0);
  });
});
