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

describe('installMcpAppsSandboxStartup', () => {
  it('installs only on dedicated mcp-app sessions and never the main session', async () => {
    const app = new EventEmitter();
    const appSession = new FakeSession();
    const defaultSession = new FakeSession();
    const sessions = {
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
      sessions,
    });
    const mainContents = new FakeWebContents(defaultSession);
    const appContents = new FakeWebContents(appSession);

    app.emit('web-contents-created', {}, mainContents);
    app.emit('web-contents-created', {}, appContents);

    expect(sessions.fromPartition).toHaveBeenCalledTimes(2);
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
