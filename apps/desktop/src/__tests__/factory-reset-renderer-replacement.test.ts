import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { createFactoryResetRendererReplacementCoordinator } from '../factory-reset-renderer-replacement';
import type { WorkspaceOpenReadySignal } from '../workspace-open-ready-ipc';

const RESET_GENERATION_CHANNEL = 'workspace:factory-reset-generation';

class TestWebContents extends EventEmitter {
  readonly id: number;
  readonly reload = vi.fn();
  readonly send = vi.fn();

  constructor(id: number) {
    super();
    this.id = id;
  }
}

class TestWindow extends EventEmitter {
  private readonly contents: TestWebContents;
  throwOnWebContentsAccess = false;

  constructor(id: number) {
    super();
    this.contents = new TestWebContents(id);
  }

  get testWebContents(): TestWebContents {
    return this.contents;
  }

  get webContents(): TestWebContents {
    if (this.throwOnWebContentsAccess) {
      throw new Error('Object has been destroyed');
    }
    return this.contents;
  }
}

const asBrowserWindow = (window: TestWindow): BrowserWindow => window as unknown as BrowserWindow;
const ready = (window: TestWindow, resetGeneration: string | null): WorkspaceOpenReadySignal => ({
  kind: 'ready',
  resetGeneration,
  senderWebContentsId: window.testWebContents.id,
});
const invalidReady = (window: TestWindow, diagnostic: string): WorkspaceOpenReadySignal => ({
  diagnostic,
  kind: 'invalid',
  senderWebContentsId: window.testWebContents.id,
});

const createCoordinator = () =>
  createFactoryResetRendererReplacementCoordinator({
    noteNextWindowReload: vi.fn(),
    timeoutMs: 1000,
  });

const startReplacementNavigation = (window: TestWindow): void => {
  window.testWebContents.emit('did-start-navigation', {
    isMainFrame: true,
    isSameDocument: false,
  });
};

const readPublishedGeneration = (window: TestWindow): string => {
  const call = window.testWebContents.send.mock.calls.find(
    ([channel]) => channel === RESET_GENERATION_CHANNEL
  );
  expect(call).toBeDefined();
  const payload = call?.[1];
  expect(payload).toEqual({ resetGeneration: expect.any(String) });
  return (payload as { resetGeneration: string }).resetGeneration;
};

describe('factory reset renderer replacement', () => {
  it('ignores a stale old-document ack and accepts the explicit replacement generation with the same frame identity', async () => {
    const coordinator = createCoordinator();
    const window = new TestWindow(11);
    let settled = false;
    const replacement = coordinator.replace([asBrowserWindow(window)]).finally(() => {
      settled = true;
    });

    coordinator.handleRendererReady(ready(window, null));
    await Promise.resolve();
    expect(settled).toBe(false);

    startReplacementNavigation(window);
    window.testWebContents.emit('dom-ready');
    const generation = readPublishedGeneration(window);
    coordinator.handleRendererReady(ready(window, generation));

    await expect(replacement).resolves.toBeUndefined();
    expect(window.testWebContents.reload).toHaveBeenCalledOnce();
  });

  it('does not treat an old did-finish-load race as the replacement document', async () => {
    const coordinator = createCoordinator();
    const window = new TestWindow(12);
    let settled = false;
    const replacement = coordinator.replace([asBrowserWindow(window)]).finally(() => {
      settled = true;
    });

    window.testWebContents.emit('did-finish-load');
    coordinator.handleRendererReady(ready(window, null));
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(window.testWebContents.send).not.toHaveBeenCalled();

    startReplacementNavigation(window);
    window.testWebContents.emit('dom-ready');
    coordinator.handleRendererReady(ready(window, readPublishedGeneration(window)));
    await expect(replacement).resolves.toBeUndefined();
  });

  it('settles a closed destroyed window even when its webContents getter throws during cleanup', async () => {
    const coordinator = createCoordinator();
    const window = new TestWindow(13);
    const replacement = coordinator.replace([asBrowserWindow(window)]);

    window.throwOnWebContentsAccess = true;
    expect(() => window.emit('closed')).not.toThrow();
    await expect(replacement).rejects.toThrow('Factory reset renderer 13 closed before readiness');
  });

  it.each([
    ['frameless', 'Renderer 14 readiness acknowledgement has no sender frame'],
    ['malformed', 'Renderer 14 readiness acknowledgement has malformed payload'],
  ])('surfaces a %s acknowledgement immediately', async (_kind, diagnostic) => {
    const coordinator = createCoordinator();
    const window = new TestWindow(14);
    const replacement = coordinator.replace([asBrowserWindow(window)]);

    coordinator.handleRendererReady(invalidReady(window, diagnostic));

    await expect(replacement).rejects.toThrow(diagnostic);
  });

  it('cancels readiness on terminal quit and removes owned listeners', async () => {
    const coordinator = createCoordinator();
    const window = new TestWindow(31);
    const quit = new AbortController();
    const replacement = coordinator.replace([asBrowserWindow(window)], quit.signal);
    quit.abort(new Error('Terminal quit'));
    await expect(replacement).resolves.toBeUndefined();
    expect(window.listenerCount('closed')).toBe(0);
    expect(window.testWebContents.listenerCount('dom-ready')).toBe(0);
    expect(window.testWebContents.listenerCount('did-start-navigation')).toBe(0);
    expect(window.testWebContents.send).not.toHaveBeenCalled();
  });

  it('does not reload after terminal quit or hide an earlier reload failure', async () => {
    const coordinator = createCoordinator();
    const window = new TestWindow(32);
    const quit = new AbortController();
    const failure = new Error('Replacement failed before quit');
    window.testWebContents.reload.mockImplementationOnce(() => {
      throw failure;
    });
    const replacement = coordinator.replace([asBrowserWindow(window)], quit.signal);
    quit.abort(new Error('Terminal quit'));
    await expect(replacement).rejects.toThrow(failure.message);
    await coordinator.replace([asBrowserWindow(window)], quit.signal);
    expect(window.testWebContents.reload).toHaveBeenCalledOnce();
  });

  it('drains sibling attempts after one reload fails and permits a clean retry', async () => {
    const coordinator = createCoordinator();
    const failedWindow = new TestWindow(21);
    const healthyWindow = new TestWindow(22);
    failedWindow.testWebContents.reload.mockImplementationOnce(() => {
      throw new Error('reload failed');
    });
    const replacement = coordinator.replace([
      asBrowserWindow(failedWindow),
      asBrowserWindow(healthyWindow),
    ]);

    startReplacementNavigation(healthyWindow);
    healthyWindow.testWebContents.emit('dom-ready');
    coordinator.handleRendererReady(ready(healthyWindow, readPublishedGeneration(healthyWindow)));
    await expect(replacement).rejects.toThrow('Factory reset failed to replace 1 renderer');

    const retry = coordinator.replace([asBrowserWindow(failedWindow)]);
    startReplacementNavigation(failedWindow);
    failedWindow.testWebContents.emit('dom-ready');
    coordinator.handleRendererReady(ready(failedWindow, readPublishedGeneration(failedWindow)));
    await expect(retry).resolves.toBeUndefined();
  });
});
