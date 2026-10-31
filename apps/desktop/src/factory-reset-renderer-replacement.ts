import { randomUUID } from 'node:crypto';
import type {
  BrowserWindow,
  Event as ElectronEvent,
  WebContentsDidStartNavigationEventParams,
} from 'electron';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { pushToRenderer } from './platform/desktop-ipc-push';
import type { WorkspaceOpenReadySignal } from './workspace-open-ready-ipc';

export interface ReplaceRenderersOptions {
  /**
   * Wipes the renderer's session storage. When given, every window first loads
   * `about:blank`, so no old document can write between the wipe and its
   * replacement, and each then loads the document it showed before.
   */
  readonly clearSessionStorage?: () => Promise<void>;
  readonly signal?: AbortSignal;
}

export interface FactoryResetRendererReplacementCoordinator {
  readonly handleRendererReady: (signal: WorkspaceOpenReadySignal) => void;
  readonly replace: (
    windows: readonly BrowserWindow[],
    options?: ReplaceRenderersOptions
  ) => Promise<void>;
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

/** Starts the replacement document's navigation; a rejection fails that window's replacement. */
type StartReplacement = () => Promise<void> | void;

const BLANK_DOCUMENT_URL = 'about:blank';

function settledFailures(results: readonly PromiseSettledResult<unknown>[]): unknown[] {
  return results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
}

const plural = (count: number): string => (count === 1 ? '' : 's');

export function createFactoryResetRendererReplacementCoordinator({
  noteNextWindowReload,
  timeoutMs,
}: CoordinatorOptions): FactoryResetRendererReplacementCoordinator {
  const readyHandlers = new Map<number, (signal: WorkspaceOpenReadySignal) => void>();

  const replaceWindow = async (
    window: BrowserWindow,
    startReplacement: StartReplacement,
    signal?: AbortSignal
  ): Promise<void> =>
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
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
          () => signal?.removeEventListener('abort', onAbort),
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
          pushToRenderer(webContents, DESKTOP_IPC_CHANNELS.workspace.factoryResetGeneration, {
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
      // Terminal quit cancels readiness, not deletion or window ownership.
      // Main's existing renderer shutdown step still joins the window.
      const onAbort = (): void => settle({ status: 'fulfilled' });
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
      signal?.addEventListener('abort', onAbort, { once: true });
      window.once('closed', onClosed);
      webContents.on('did-start-navigation', onDidStartNavigation);
      webContents.on('dom-ready', onDomReady);
      try {
        noteNextWindowReload(window);
        Promise.resolve(startReplacement()).catch((error: unknown) => {
          settle({ reason: error, status: 'rejected' });
        });
      } catch (error) {
        settle({ reason: error, status: 'rejected' });
      }
    });

  return {
    handleRendererReady: (signal) => {
      readyHandlers.get(signal.senderWebContentsId)?.(signal);
    },
    replace: async (windows, { clearSessionStorage, signal } = {}) => {
      if (!clearSessionStorage) {
        const results = await Promise.allSettled(
          windows.map((window) => replaceWindow(window, () => window.webContents.reload(), signal))
        );
        throwReplacementFailures(settledFailures(results));
        return;
      }
      // Each old document unloads before the wipe, so none can write into the
      // cleared storage; each window then loads the document it showed before.
      const documents = windows.map((window) => ({ url: window.webContents.getURL(), window }));
      const unloaded = await Promise.allSettled(
        documents.map(({ window }) => window.webContents.loadURL(BLANK_DOCUMENT_URL))
      );
      const unloadFailures = settledFailures(unloaded);
      let clearFailure: unknown[] = [];
      if (unloadFailures.length === 0) {
        clearFailure = await clearSessionStorage().then(
          () => [],
          (error: unknown) => [error]
        );
      }
      // A window is never left blank: it gets its document back even when the wipe failed.
      const results = await Promise.allSettled(
        documents.map(({ url, window }) =>
          replaceWindow(window, () => window.webContents.loadURL(url), signal)
        )
      );
      if (unloadFailures.length > 0) {
        throw new AggregateError(
          unloadFailures,
          `Factory reset could not unload ${unloadFailures.length} renderer${plural(unloadFailures.length)}, so it did not clear their storage`
        );
      }
      if (clearFailure.length > 0) {
        throw new AggregateError(clearFailure, 'Factory reset could not clear renderer storage');
      }
      throwReplacementFailures(settledFailures(results));
    },
  };
}

function throwReplacementFailures(failures: readonly unknown[]): void {
  if (failures.length > 0) {
    const diagnostics = failures.map(errorMessage).join('; ');
    throw new AggregateError(
      failures,
      `Factory reset failed to replace ${failures.length} renderer${plural(failures.length)}: ${diagnostics}`
    );
  }
}
