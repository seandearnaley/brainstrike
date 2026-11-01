import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { trackAppWindow } from '../app-windows';
import {
  admitDocumentClose,
  type DocumentUnloadOwner,
  type DocumentWindow,
  installDocumentUnload,
  reloadDocument,
  visibleDocumentWindows,
} from '../document-unload';

const electron = vi.hoisted(() => ({ windows: [] as unknown[] }));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => electron.windows },
}));
const prepare = vi.hoisted(() => ({ prepareDocumentUnload: vi.fn() }));
vi.mock('../prepare-document-unload', () => prepare);

let nextWebContentsId = 1;

function windowFixture() {
  const window = new EventEmitter();
  const contents = new EventEmitter();
  let destroyed = false;
  const fixture = Object.assign(window, {
    /** A native close: Main's `close` listeners run first, then the window closes unless prevented. */
    close: vi.fn(() => {
      const event = { preventDefault: vi.fn() };
      window.emit('close', event);
      if (!event.preventDefault.mock.calls.length) {
        destroyed = true;
        window.emit('closed');
      }
    }),
    destroy: vi.fn(() => {
      destroyed = true;
      window.emit('closed');
    }),
    isDestroyed: () => destroyed,
    webContents: Object.assign(contents, {
      id: nextWebContentsId++,
      mainFrame: { postMessage: vi.fn() },
    }),
  });
  return fixture as typeof fixture & DocumentWindow;
}

type Fixture = ReturnType<typeof windowFixture>;

/** The user's close (window-X, Alt+F4, Cmd+W): one `close` event Main may prevent. */
function userClose(window: Fixture): { preventDefault: ReturnType<typeof vi.fn> } {
  const event = { preventDefault: vi.fn() };
  window.emit('close', event);
  return event;
}

function ownerOf(
  visible: () => readonly Fixture[],
  overrides: Partial<DocumentUnloadOwner<Fixture>> = {}
) {
  const quit = vi.fn<() => void>();
  return {
    delays: { delay: async () => undefined },
    isQuitting: () => false,
    quitsWithLastWindow: () => false,
    visibleWindows: visible,
    ...overrides,
    quit,
  } satisfies DocumentUnloadOwner<Fixture>;
}

beforeEach(() => {
  electron.windows = [];
  prepare.prepareDocumentUnload.mockReset();
  prepare.prepareDocumentUnload.mockResolvedValue(undefined);
});

describe('user window close', () => {
  it('prepares the document first, then closes the window past the interception', async () => {
    const window = windowFixture();
    const other = windowFixture();
    const flushed = Promise.withResolvers<void>();
    prepare.prepareDocumentUnload.mockReturnValueOnce(flushed.promise);
    installDocumentUnload(
      window,
      ownerOf(() => [window, other], { quitsWithLastWindow: () => true })
    );

    const event = userClose(window);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(prepare.prepareDocumentUnload).toHaveBeenCalledWith(window, expect.anything());
    expect(window.close).not.toHaveBeenCalled();
    // A repeated close while the document flushes starts nothing new.
    expect(userClose(window).preventDefault).toHaveBeenCalledOnce();
    expect(prepare.prepareDocumentUnload).toHaveBeenCalledOnce();

    flushed.resolve();
    await vi.waitFor(() => expect(window.isDestroyed()).toBe(true));
    expect(window.close).toHaveBeenCalledOnce();
  });

  it('still closes the window when its document could not confirm the flush', async () => {
    const window = windowFixture();
    prepare.prepareDocumentUnload.mockRejectedValueOnce(new Error('Renderer closed early'));
    installDocumentUnload(
      window,
      ownerOf(() => [window])
    );

    userClose(window);

    await vi.waitFor(() => expect(window.isDestroyed()).toBe(true));
  });

  it('where nothing keeps the app running, the last visible window quits instead and leaves its unload to quit', () => {
    const window = windowFixture();
    const owner = ownerOf(() => [window], { quitsWithLastWindow: () => true });
    installDocumentUnload(window, owner);

    const event = userClose(window);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(owner.quit).toHaveBeenCalledOnce();
    expect(prepare.prepareDocumentUnload).not.toHaveBeenCalled();
    expect(window.isDestroyed()).toBe(false);
  });

  it('a window whose document is already unloading does not keep the last one from quitting', () => {
    const first = windowFixture();
    const last = windowFixture();
    prepare.prepareDocumentUnload.mockReturnValue(new Promise(() => undefined));
    const owner = ownerOf(() => [first, last], { quitsWithLastWindow: () => true });
    installDocumentUnload(first, owner);
    installDocumentUnload(last, owner);

    userClose(first);
    userClose(last);

    expect(owner.quit).toHaveBeenCalledOnce();
  });

  it('where the Dock or tray keeps the app running, the last window closes through its own unload', async () => {
    const window = windowFixture();
    const owner = ownerOf(() => [window], { quitsWithLastWindow: () => false });
    installDocumentUnload(window, owner);

    userClose(window);

    await vi.waitFor(() => expect(window.isDestroyed()).toBe(true));
    expect(owner.quit).not.toHaveBeenCalled();
    expect(prepare.prepareDocumentUnload).toHaveBeenCalledOnce();
  });

  it('once quit has started, a user close waits for quit to prepare and close the window', () => {
    const window = windowFixture();
    const owner = ownerOf(() => [window], {
      isQuitting: () => true,
      quitsWithLastWindow: () => true,
    });
    installDocumentUnload(window, owner);

    expect(userClose(window).preventDefault).toHaveBeenCalledOnce();
    expect(owner.quit).not.toHaveBeenCalled();
    expect(prepare.prepareDocumentUnload).not.toHaveBeenCalled();
  });

  it("lets Main's own close of a prepared window through, until that window has closed", () => {
    const window = windowFixture();
    installDocumentUnload(
      window,
      ownerOf(() => [window])
    );
    admitDocumentClose(window);

    expect(userClose(window).preventDefault).not.toHaveBeenCalled();
    window.emit('closed');
    expect(userClose(window).preventDefault).toHaveBeenCalledOnce();
  });

  it('never lets the page veto an unload Main owns', () => {
    const window = windowFixture();
    installDocumentUnload(
      window,
      ownerOf(() => [window])
    );
    const veto = { preventDefault: vi.fn() };

    window.webContents.emit('will-prevent-unload', veto);

    expect(veto.preventDefault).toHaveBeenCalledOnce();
  });
});

describe('visible documents', () => {
  it('never counts an untracked window or a destroyed window', () => {
    const appWindow = () => {
      const window = windowFixture();
      trackAppWindow(window as never);
      return window;
    };
    const visible = appWindow();
    const destroyed = appWindow();
    destroyed.destroy();
    electron.windows = [windowFixture(), visible, destroyed];

    expect(visibleDocumentWindows()).toEqual([visible]);
  });
});

describe('owned reload', () => {
  const owner = { delays: { delay: async () => undefined }, isQuitting: () => false };

  it('flushes the document before replacing it', async () => {
    const window = windowFixture();
    const order: string[] = [];
    prepare.prepareDocumentUnload.mockImplementationOnce(async () => {
      order.push('flushed');
    });

    await reloadDocument(window, owner, () => order.push('reloaded'));

    expect(order).toEqual(['flushed', 'reloaded']);
  });

  it('still replaces a document that could not confirm its flush', async () => {
    const window = windowFixture();
    const reload = vi.fn();
    prepare.prepareDocumentUnload.mockRejectedValueOnce(new Error('Renderer refused'));

    await reloadDocument(window, owner, reload);

    expect(reload).toHaveBeenCalledOnce();
  });

  it('leaves a window to quit, or to its own retirement, instead of reloading it', async () => {
    const reload = vi.fn();
    await reloadDocument(windowFixture(), { ...owner, isQuitting: () => true }, reload);
    const destroyed = windowFixture();
    destroyed.destroy();
    await reloadDocument(destroyed, owner, reload);

    expect(reload).not.toHaveBeenCalled();
  });
});
