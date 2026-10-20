import { MessageChannelMain, type MessagePortMain } from 'electron';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';

interface RendererCloseWindow {
  destroy(): void;
  isDestroyed(): boolean;
  once(event: 'closed', listener: () => void): unknown;
  removeListener(event: 'closed', listener: () => void): unknown;
  readonly webContents: {
    readonly mainFrame: {
      postMessage(channel: string, message: null, transfer: MessagePortMain[]): void;
    };
    once(event: 'render-process-gone', listener: () => void): unknown;
    removeListener(event: 'render-process-gone', listener: () => void): unknown;
  };
}

/** Main's existing shutdown deadline owns a renderer that cannot acknowledge its producers. */
export function prepareDesktopRendererClose(
  window: RendererCloseWindow,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted();
  const contents = window.webContents;
  const { port1, port2 } = new MessageChannelMain();
  return new Promise((resolve, reject) => {
    let settled = false;
    let transferred = false;
    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      window.removeListener('closed', gone);
      contents.removeListener('render-process-gone', crashed);
      signal.removeEventListener('abort', aborted);
      port1.removeAllListeners();
      port1.close();
      if (!transferred) {
        port2.close();
      }
      if (error) {
        reject(error);
        return;
      }
      resolve();
    };
    const gone = (): void =>
      finish(new Error('Renderer closed before acknowledging its producers'));
    const crashed = (): void => {
      const error = new Error('Renderer exited before acknowledging its producers');
      // Other crash listeners still read the window during this event's dispatch.
      setImmediate(() => {
        try {
          if (!window.isDestroyed()) {
            window.destroy();
          }
        } catch (cause) {
          finish(new AggregateError([error, cause], 'Crashed renderer could not be retired'));
          return;
        }
        finish(error);
      });
    };
    const aborted = (): void =>
      finish(
        new Error('Renderer close preparation was interrupted', {
          cause: signal.reason,
        })
      );
    window.once('closed', gone);
    contents.once('render-process-gone', crashed);
    signal.addEventListener('abort', aborted, { once: true });
    port1.on('close', gone);
    port1.on('message', ({ data }: { data: unknown }) => {
      if (
        !data ||
        typeof data !== 'object' ||
        Object.keys(data).length !== 1 ||
        !('prepared' in data) ||
        data.prepared !== true
      ) {
        finish(new Error('Renderer producers did not acknowledge close preparation'));
        return;
      }
      finish();
    });
    port1.start();
    try {
      contents.mainFrame.postMessage(DESKTOP_IPC_CHANNELS.agent.prepareClose, null, [port2]);
      transferred = true;
    } catch (cause) {
      finish(new Error('Renderer close preparation could not be delivered', { cause }));
    }
  });
}
