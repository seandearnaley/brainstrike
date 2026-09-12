interface ShutdownRendererWindow {
  close(): void;
  isDestroyed(): boolean;
  once(event: 'closed', listener: () => void): unknown;
  removeListener(event: 'closed', listener: () => void): unknown;
}

function closeRenderer(window: ShutdownRendererWindow): Promise<void> {
  return new Promise((resolve, reject) => {
    const closed = () => resolve();
    window.once('closed', closed);
    try {
      // Normal close preserves beforeunload/unload and window state persistence.
      // The existing application deadline owns an unresponsive renderer.
      window.close();
    } catch (error) {
      window.removeListener('closed', closed);
      if (window.isDestroyed()) {
        resolve();
        return;
      }
      reject(error);
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
