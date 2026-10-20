import { createLogger } from '@brainstrike/logging';
import { MessageChannelMain, type MessagePortMain } from 'electron';
import type { LifecycleDelaySeam } from './lifecycle-delay-seam';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';

const logger = createLogger('RendererClose');

/**
 * R5(b) (ADR-0026): how long a renderer may take to acknowledge its close preparation (flush
 * its durable writers, close its host transport) before Main escalates that cooperative close
 * to `destroy()` and joins the window's `closed`. Escalating is a warn and a failed preparation,
 * never an abandoned window.
 */
export const RENDERER_CLOSE_PREPARATION_MS = 30_000;

interface RendererCloseWindow {
  destroy(): void;
  isDestroyed(): boolean;
  once(event: 'closed', listener: () => void): unknown;
  removeListener(event: 'closed', listener: () => void): unknown;
  readonly webContents: {
    readonly mainFrame: {
      postMessage(channel: string, message: null, transfer: MessagePortMain[]): void;
    };
    once(event: 'render-process-gone' | 'unresponsive', listener: () => void): unknown;
    removeListener(event: 'render-process-gone' | 'unresponsive', listener: () => void): unknown;
  };
}

/**
 * Asks a visible renderer to prepare its document for close and joins its ACK. A renderer that
 * cannot answer is retired, never waited on forever: one that crashes or becomes unresponsive,
 * or that has not answered within `RENDERER_CLOSE_PREPARATION_MS`, is destroyed and its
 * `closed` joined before this rejects. A negative ACK, a lost port or an undeliverable request
 * rejects at once. `delays` is the E2E lifecycle seam's Main-side `renderer-flush` point.
 */
export function prepareDesktopRendererClose(
  window: RendererCloseWindow,
  delays: Pick<LifecycleDelaySeam, 'delay'>
): Promise<void> {
  const contents = window.webContents;
  const { port1, port2 } = new MessageChannelMain();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let transferred = false;
    /** Set once Main retires the renderer itself: from then on only its `closed` settles. */
    let retiring: Error | undefined;
    const ladder = setTimeout(() => {
      logger.warn('Renderer did not acknowledge close preparation; destroying it', {
        preparationMs: RENDERER_CLOSE_PREPARATION_MS,
      });
      retire(
        new Error(
          `Renderer did not acknowledge close preparation within ${RENDERER_CLOSE_PREPARATION_MS} ms`
        )
      );
    }, RENDERER_CLOSE_PREPARATION_MS);
    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(ladder);
      window.removeListener('closed', closed);
      contents.removeListener('render-process-gone', crashed);
      contents.removeListener('unresponsive', unresponsive);
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
    /** Destroys the window and lets its `closed` settle this preparation with `error`. */
    const retire = (error: Error): void => {
      if (settled || retiring) {
        return;
      }
      retiring = error;
      clearTimeout(ladder);
      try {
        if (!window.isDestroyed()) {
          window.destroy();
        }
      } catch (cause) {
        finish(new AggregateError([error, cause], 'Renderer could not be retired'));
      }
    };
    // After its ACK the renderer may close its end: the outcome is already decided.
    let acknowledged = false;
    const closed = (): void =>
      finish(
        retiring ??
          (acknowledged
            ? undefined
            : new Error('Renderer closed before acknowledging its producers'))
      );
    const portClosed = (): void => {
      if (!(retiring || acknowledged)) {
        finish(new Error('Renderer closed before acknowledging its producers'));
      }
    };
    // Other crash and hang listeners still read the window during this event's dispatch.
    const crashed = (): void => {
      setImmediate(() => retire(new Error('Renderer exited before acknowledging its producers')));
    };
    const unresponsive = (): void => {
      setImmediate(() =>
        retire(new Error('Renderer became unresponsive before acknowledging its producers'))
      );
    };
    window.once('closed', closed);
    contents.once('render-process-gone', crashed);
    contents.once('unresponsive', unresponsive);
    port1.on('close', portClosed);
    port1.on('message', ({ data }: { data: unknown }) => {
      if (acknowledged) {
        return;
      }
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
      acknowledged = true;
      // E2E seam: a slow flush's ACK reaches Main this much later, still inside the ladder.
      void delays.delay('renderer-flush').then(() => finish());
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
