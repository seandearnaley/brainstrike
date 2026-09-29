import { randomUUID } from 'node:crypto';
import type {
  BrowserWindow,
  Event as ElectronEvent,
  WebContentsDidStartNavigationEventParams,
} from 'electron';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import type { WorkspaceOpenReadySignal } from './workspace-open-ready-ipc';

export interface FactoryResetRendererReplacementCoordinator {
  readonly handleRendererReady: (signal: WorkspaceOpenReadySignal) => void;
  readonly replace: (windows: readonly BrowserWindow[]) => Promise<void>;
}

interface CoordinatorOptions {
  readonly noteNextWindowReload: (window: BrowserWindow) => void;
  readonly timeoutMs: number;
}

type Settlement =
  | { readonly status: 'fulfilled' }
  | { readonly reason: unknown; readonly status: 'rejected' };

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const collectCleanupFailures = (operations: readonly (() => void)[]): unknown[] => {
  const failures: unknown[] = [];
  for (const operation of operations) {
    try {
      operation();
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
};

const finishSettlement = (
  settlement: Settlement,
  cleanupFailures: readonly unknown[],
  webContentsId: number,
  resolve: () => void,
  reject: (reason?: unknown) => void
): void => {
  if (cleanupFailures.length > 0) {
    const causes =
      settlement.status === 'rejected' ? [settlement.reason, ...cleanupFailures] : cleanupFailures;
    reject(
      new AggregateError(
        causes,
        `Factory reset renderer ${webContentsId} cleanup reported ${cleanupFailures.length} error${cleanupFailures.length === 1 ? '' : 's'}`
      )
    );
    return;
  }
  if (settlement.status === 'rejected') {
    reject(settlement.reason);
    return;
  }
  resolve();
};

export function createFactoryResetRendererReplacementCoordinator({
  noteNextWindowReload,
  timeoutMs,
}: CoordinatorOptions): FactoryResetRendererReplacementCoordinator {
  const readyHandlers = new Map<number, (signal: WorkspaceOpenReadySignal) => void>();

  const replaceWindow = async (window: BrowserWindow): Promise<void> =>
    await new Promise<void>((resolve, reject) => {
      // Capture the object and id before installing `closed`: Electron's
      // BrowserWindow.webContents getter may itself throw after destruction.
      // No close-path cleanup reads that getter again.
      const webContents = window.webContents;
      const webContentsId = webContents.id;
      if (readyHandlers.has(webContentsId)) {
        reject(new Error(`Factory reset renderer ${webContentsId} already awaits readiness`));
        return;
      }

      const resetGeneration = randomUUID();
      let replacementNavigationStarted = false;
      let resetGenerationPublished = false;
      let settled = false;
      let timeout: NodeJS.Timeout;

      const settle = (settlement: Settlement): void => {
        if (settled) {
          return;
        }
        settled = true;

        const cleanupFailures = collectCleanupFailures([
          () => clearTimeout(timeout),
          () => readyHandlers.delete(webContentsId),
          () => window.removeListener('closed', onClosed),
          () => webContents.removeListener('did-start-navigation', onDidStartNavigation),
          () => webContents.removeListener('dom-ready', onDomReady),
        ]);

        finishSettlement(settlement, cleanupFailures, webContentsId, resolve, reject);
      };

      const onDidStartNavigation = (
        details: ElectronEvent<WebContentsDidStartNavigationEventParams>
      ): void => {
        if (details.isMainFrame && !details.isSameDocument) {
          replacementNavigationStarted = true;
        }
      };
      const onDomReady = (): void => {
        if (!replacementNavigationStarted || resetGenerationPublished) {
          return;
        }
        resetGenerationPublished = true;
        try {
          webContents.send(DESKTOP_IPC_CHANNELS.workspace.factoryResetGeneration, {
            resetGeneration,
          });
        } catch (error) {
          settle({
            reason: new Error(
              `Factory reset renderer ${webContentsId} could not receive its generation challenge: ${errorMessage(error)}`,
              { cause: error }
            ),
            status: 'rejected',
          });
        }
      };
      const onClosed = (): void => {
        settle({
          reason: new Error(`Factory reset renderer ${webContentsId} closed before readiness`),
          status: 'rejected',
        });
      };

      timeout = setTimeout(() => {
        settle({
          reason: new Error(`Timed out waiting for renderer ${webContentsId} readiness`),
          status: 'rejected',
        });
      }, timeoutMs);
      timeout.unref();

      readyHandlers.set(webContentsId, (signal) => {
        if (signal.kind === 'invalid') {
          settle({ reason: new Error(signal.diagnostic), status: 'rejected' });
          return;
        }
        // `null` belongs to an ordinary or old document that never received
        // this reset attempt's main-issued challenge. A different string is a
        // stale acknowledgement from an earlier attempt. Neither can settle.
        if (signal.resetGeneration !== resetGeneration) {
          return;
        }
        settle({ status: 'fulfilled' });
      });
      window.once('closed', onClosed);
      webContents.on('did-start-navigation', onDidStartNavigation);
      webContents.on('dom-ready', onDomReady);
      try {
        noteNextWindowReload(window);
        webContents.reload();
      } catch (error) {
        settle({ reason: error, status: 'rejected' });
      }
    });

  return {
    handleRendererReady: (signal) => {
      readyHandlers.get(signal.senderWebContentsId)?.(signal);
    },
    replace: async (windows) => {
      const results = await Promise.allSettled(windows.map(replaceWindow));
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      );
      if (failures.length > 0) {
        const diagnostics = failures.map(errorMessage).join('; ');
        throw new AggregateError(
          failures,
          `Factory reset failed to replace ${failures.length} renderer${failures.length === 1 ? '' : 's'}: ${diagnostics}`
        );
      }
    },
  };
}
