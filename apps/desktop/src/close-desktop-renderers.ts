interface ShutdownRendererWindow {
  close(): void;
  destroy(): void;
  isDestroyed(): boolean;
  once(event: 'closed', listener: () => void): unknown;
  removeListener(event: 'closed', listener: () => void): unknown;
  readonly webContents: {
    once(event: 'render-process-gone', listener: () => void): unknown;
    removeListener(event: 'render-process-gone', listener: () => void): unknown;
  };
}

function closeRenderer(window: ShutdownRendererWindow): Promise<void> {
  return new Promise((resolve, reject) => {
    // A renderer that exits mid-close never acknowledges its unload, so that close waits
    // forever: a signal to Main's process group ends it there (BST-2135). Its page can run no
    // unload handler any more, and `destroy` guarantees `closed`. Deferred past this event's
    // dispatch: its other listeners still read the window.
    const contents = window.webContents;
    const closed = () => {
      contents.removeListener('render-process-gone', gone);
      resolve();
    };
    // A close or destroy that throws settles this renderer: destroyed is closed, else its cause.
    const fail = (error: unknown) => {
      window.removeListener('closed', closed);
      contents.removeListener('render-process-gone', gone);
      if (window.isDestroyed()) {
        resolve();
        return;
      }
      reject(error);
    };
    const gone = () => {
      setImmediate(() => {
        try {
          if (!window.isDestroyed()) {
            window.destroy();
          }
        } catch (error) {
          fail(error);
        }
      });
    };
    window.once('closed', closed);
    contents.once('render-process-gone', gone);
    try {
      // Normal close preserves beforeunload/unload and window state persistence.
      // The existing application deadline owns an unresponsive renderer.
      window.close();
    } catch (error) {
      fail(error);
    }
  });
}

/** Stop renderer producers while their IPC dependencies are still available. */
export async function closeDesktopRenderers<Window extends ShutdownRendererWindow>(
  windows: readonly Window[],
  isOwnedHostWindow: (window: Window) => boolean
): Promise<void> {
  const closes: Promise<void>[] = [];
  for (const window of windows) {
    if (!(window.isDestroyed() || isOwnedHostWindow(window))) {
      closes.push(closeRenderer(window));
    }
  }
  const results = await Promise.allSettled(closes);
  const failures: unknown[] = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Desktop renderer shutdown failed');
  }
}
