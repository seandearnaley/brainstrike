import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { configureDesktopRendererTarget } from '../desktop-renderer-target';
import { RendererHostLifecycle, type RendererHostStatusShape } from '../renderer-host-lifecycle';

const { createWindow } = vi.hoisted(() => ({ createWindow: vi.fn() }));
vi.mock('electron', () => ({
  app: { getAppPath: () => '/tmp/brainstrike', isPackaged: false },
  BrowserWindow: Object.assign(
    vi.fn(function BrowserWindowMock() {
      return createWindow();
    }),
    {
      getAllWindows: () => [],
    }
  ),
}));

class Window extends EventEmitter {
  readonly id = 101;
  destroyed = false;
  readonly webContents = Object.assign(new EventEmitter(), {
    id: 201,
    send: vi.fn(),
    setWindowOpenHandler: vi.fn(),
  });
  readonly destroy = vi.fn(() => {
    // Electron marks the object destroyed before its physical close receipt.
    this.destroyed = true;
  });
  readonly loadFile = vi.fn(async () => {});
  readonly loadURL = vi.fn(async () => {});
  isDestroyed() {
    return this.destroyed;
  }
}

function fixture() {
  const window = new Window();
  createWindow.mockReturnValue(window);
  const lifecycle = new RendererHostLifecycle<RendererHostStatusShape>({
    createStatus: (status) => ({ ...status }),
    createStoppedStatus: () => ({
      active: false,
      lastError: null,
      runtimeId: 'embedding-host:stopped',
      state: 'stopped',
    }),
    mode: 'embedding-host',
    role: 'embedding-host',
    statusEventName: 'embedding-host:status',
    timeoutMessage: 'Timed out waiting for embedding host state transition.',
  });
  window.loadURL.mockImplementation(async () => {
    lifecycle.setStatus({ ...lifecycle.getStatus(), state: 'running' });
  });
  return { lifecycle, window };
}

beforeEach(() => {
  vi.clearAllMocks();
  configureDesktopRendererTarget({
    kind: 'dev-renderer',
    launchMode: 'dev-server',
    url: 'http://localhost:5173',
  });
});

describe('RendererHostLifecycle physical resource ownership', () => {
  it('accepts only current terminal protocol during Stop and holds Start through physical closure', async () => {
    const { lifecycle, window } = fixture();
    await lifecycle.ensureStarted();
    const replacement = new Window();
    replacement.loadURL.mockImplementation(async () => {
      lifecycle.setStatus({ ...lifecycle.getStatus(), state: 'running' });
    });
    replacement.destroy.mockImplementation(() => {
      replacement.destroyed = true;
      replacement.emit('closed');
    });
    createWindow.mockReturnValue(replacement);
    const status = lifecycle.getStatus();
    const terminal = { ...status, state: 'stopped' as const };
    const protocol = vi.fn(async () => {
      await lifecycle.waitForStatus((next) => next.state === 'stopped', 30_000);
    });
    const stopped = lifecycle.stop(protocol);
    await vi.waitFor(() => expect(protocol).toHaveBeenCalledOnce());
    const host = lifecycle.getHostWindow();
    if (!host) {
      throw new Error('Expected the still-owned retiring window');
    }
    expect(lifecycle.isHostWindow(host)).toBe(true);
    expect(lifecycle.acceptsStatus(window.webContents.id, status)).toBe(false);
    expect(lifecycle.acceptsStatus(999, terminal)).toBe(false);
    expect(
      lifecycle.acceptsStatus(window.webContents.id, { ...terminal, runtimeId: 'stale' })
    ).toBe(false);
    expect(lifecycle.acceptsStatus(window.webContents.id, terminal)).toBe(true);
    const started = lifecycle.ensureStarted();
    expect(createWindow).toHaveBeenCalledOnce();
    expect(window.destroy).not.toHaveBeenCalled();
    lifecycle.setStatus(terminal);
    await vi.waitFor(() => expect(window.destroy).toHaveBeenCalledOnce());
    expect(createWindow).toHaveBeenCalledOnce();
    window.emit('closed');
    await stopped;
    expect((await started).state).toBe('running');
    expect(createWindow).toHaveBeenCalledTimes(2);
    expect(lifecycle.getHostWindow()).toBe(replacement);
    await lifecycle.dispose();
  });

  it('fails a lost acknowledgement on process exit, joins cleanup, and never admits a replacement', async () => {
    const { lifecycle, window } = fixture();
    await lifecycle.ensureStarted();
    const protocol = vi.fn(async () => {
      await lifecycle.waitForStatus((status) => status.state === 'stopped', 30_000);
    });
    const stopped = lifecycle.stop(protocol);
    const rejected = expect(stopped).rejects.toMatchObject({ code: 'process.lost' });
    await vi.waitFor(() => expect(protocol).toHaveBeenCalledOnce());
    window.webContents.emit('render-process-gone', {}, { exitCode: 11, reason: 'crashed' });
    await rejected;
    expect(window.destroy).toHaveBeenCalledOnce();
    expect((await lifecycle.ensureStarted()).state).toBe('error');
    expect(createWindow).toHaveBeenCalledOnce();
    await lifecycle.dispose();
  });

  it('preserves a lost acknowledgement and independent destroy failure while retaining the window', async () => {
    const { lifecycle, window } = fixture();
    await lifecycle.ensureStarted();
    const acknowledgement = new Error('Stop acknowledgement deadline');
    const cleanup = new Error('BrowserWindow destruction failure');
    window.destroy.mockImplementationOnce(() => {
      throw cleanup;
    });
    const failed = lifecycle.stop(async () => {
      throw acknowledgement;
    });
    await expect(failed).rejects.toMatchObject({ errors: [acknowledgement, cleanup] });
    expect(lifecycle.getHostWindow()).toBe(window);
    const retried = lifecycle.destroyHostWindow();
    await vi.waitFor(() => expect(window.destroy).toHaveBeenCalledTimes(2));
    window.emit('closed');
    await retried;
    await lifecycle.dispose();
  });

  it('spends one process replacement, ignores old receipts, and rearms only on explicit restart', async () => {
    const { lifecycle } = fixture();
    const windows: Window[] = [];
    createWindow.mockImplementation(() => {
      const window = new Window();
      window.loadURL.mockImplementation(async () => {
        lifecycle.setStatus({ ...lifecycle.getStatus(), state: 'running' });
      });
      window.destroy.mockImplementation(() => {
        window.destroyed = true;
        window.emit('closed');
      });
      windows.push(window);
      return window;
    });
    await lifecycle.ensureStarted();
    windows[0]!.webContents.emit('render-process-gone', {}, { exitCode: 11, reason: 'crashed' });
    await lifecycle.ensureStarted();
    expect(windows).toHaveLength(2);
    windows[0]!.emit('closed');
    expect(lifecycle.getHostWindow()).toBe(windows[1]);
    windows[1]!.webContents.emit('render-process-gone', {}, { exitCode: 11, reason: 'crashed' });
    expect((await lifecycle.ensureStarted()).state).toBe('error');
    expect(windows).toHaveLength(2);
    await lifecycle.restart();
    expect(windows).toHaveLength(3);
    windows[2]!.webContents.emit('render-process-gone', {}, { exitCode: 11, reason: 'crashed' });
    await lifecycle.ensureStarted();
    expect(windows).toHaveLength(4);
    await lifecycle.dispose();
  });

  it('joins concurrent fault retirement and ignores a delayed fault from the replaced runtime', async () => {
    const { lifecycle, window } = fixture();
    await lifecycle.ensureStarted();
    const runtimeId = lifecycle.getStatus().runtimeId;
    const failure = new Error('Engine execution failed');
    const first = lifecycle.retire(failure, runtimeId);
    const second = lifecycle.retire(failure, runtimeId);
    await vi.waitFor(() => expect(window.destroy).toHaveBeenCalledOnce());
    window.emit('closed');
    await Promise.all([first, second]);
    const replacement = new Window();
    replacement.loadURL.mockImplementation(async () => {
      lifecycle.setStatus({ ...lifecycle.getStatus(), state: 'running' });
    });
    replacement.destroy.mockImplementation(() => {
      replacement.destroyed = true;
      replacement.emit('closed');
    });
    createWindow.mockReturnValue(replacement);
    await lifecycle.ensureStarted();
    await lifecycle.retire(failure, runtimeId);
    expect(replacement.destroy).not.toHaveBeenCalled();
    expect(lifecycle.getHostWindow()).toBe(replacement);
    await lifecycle.retire(failure, lifecycle.getStatus().runtimeId);
    expect((await lifecycle.ensureStarted()).state).toBe('error');
    expect(createWindow).toHaveBeenCalledTimes(2);
    await lifecycle.dispose();
  });

  it('keeps retirement pending until the actual closed receipt, even after destroy returns', async () => {
    const { lifecycle, window } = fixture();
    await lifecycle.ensureStarted();
    let retired = false;
    const retiring = Promise.resolve(lifecycle.destroyHostWindow()).then(() => {
      retired = true;
    });
    await vi.waitFor(() => expect(window.destroy).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(window.isDestroyed()).toBe(true);
    expect(retired).toBe(false);
    window.emit('closed');
    await retiring;
    expect(retired).toBe(true);
    expect(window.listenerCount('closed')).toBe(0);
    expect(window.webContents.listenerCount('render-process-gone')).toBe(0);
    expect(window.webContents.listenerCount('did-fail-load')).toBe(0);
    await lifecycle.dispose();
  });

  it('retains the physical owner and original destruction failure for an explicit close retry', async () => {
    const { lifecycle, window } = fixture();
    await lifecycle.ensureStarted();
    const cause = new Error('BrowserWindow destroy failure');
    window.destroy.mockImplementationOnce(() => {
      throw cause;
    });
    await expect(Promise.resolve().then(() => lifecycle.destroyHostWindow())).rejects.toBe(cause);
    expect(lifecycle.getHostWindow()).toBe(window);
    const retiring = Promise.resolve(lifecycle.destroyHostWindow());
    await vi.waitFor(() => expect(window.destroy).toHaveBeenCalledTimes(2));
    window.emit('closed');
    await retiring;
    expect(lifecycle.getHostWindow()).toBeNull();
    await lifecycle.dispose();
  });
});
