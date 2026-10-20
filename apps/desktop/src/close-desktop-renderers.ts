interface ShutdownRendererWindow {
  close(): void;
  destroy(): void;
  isDestroyed(): boolean;
  once(event: 'closed', listener: () => void): unknown;
  removeListener(event: 'closed', listener: () => void): unknown;
  readonly webContents: {
    on(event: 'will-prevent-unload', listener: (event: UnloadVeto) => void): unknown;
    once(event: 'render-process-gone' | 'unresponsive', listener: () => void): unknown;
    removeListener(event: 'render-process-gone' | 'unresponsive', listener: () => void): unknown;
    removeListener(event: 'will-prevent-unload', listener: (event: UnloadVeto) => void): unknown;
  };
}

interface UnloadVeto {
  preventDefault(): void;
}

function closeRenderer(window: ShutdownRendererWindow): Promise<void> {
  return new Promise((resolve, reject) => {
    const contents = window.webContents;
    const detach = () => {
      contents.removeListener('render-process-gone', retire);
      contents.removeListener('unresponsive', retire);
      contents.removeListener('will-prevent-unload', overrideUnloadVeto);
    };
    const closed = () => {
      detach();
      resolve();
    };
    // A close or destroy that throws settles this renderer: destroyed is closed, else its cause.
    const fail = (error: unknown) => {
      window.removeListener('closed', closed);
      detach();
      if (window.isDestroyed()) {
        resolve();
        return;
      }
      reject(error);
    };
    // A renderer that exits or hangs mid-close never acknowledges its unload, so that close
    // would wait forever (BST-2135): it is destroyed instead, which guarantees `closed`. Its page
    // can run no unload handler any more. Deferred past this event's dispatch: its other
    // listeners still read the window.
    const retire = () => {
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
    // App-owned quit is terminal: a page's beforeunload cannot veto it (ADR-0026 R4).
    const overrideUnloadVeto = (event: UnloadVeto) => {
      event.preventDefault();
    };
    window.once('closed', closed);
    contents.once('render-process-gone', retire);
    contents.once('unresponsive', retire);
    contents.on('will-prevent-unload', overrideUnloadVeto);
    try {
      // Normal close preserves beforeunload/unload and window state persistence.
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
