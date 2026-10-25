import { EventEmitter } from 'node:events';
import path from 'node:path';
import { runAtPromiseBoundary } from '@brainstrike/effect-kit';
import { createLogger } from '@brainstrike/logging';
import { createRuntimeId } from '@brainstrike/worker-runtime';
import { Effect, Schedule } from 'effect';
import { app, BrowserWindow } from 'electron';
import {
  type DesktopRendererTarget,
  rendererDocumentUrl,
  resolveDesktopRendererTarget,
} from './desktop-renderer-target';
import { resolveDistRoot } from './dist-root';
import { joinWindowClosed } from './window-lifecycle-utils';
import {
  assignWindowRole,
  clearWindowRoleByWebContentsId,
  type DesktopWindowRole,
  getTrackedWindowsByRole,
} from './window-role';

const HOST_LOAD_RETRY_ATTEMPTS = 3;
const logger = createLogger('RendererHostLifecycle');
const RENDERER_HOST_LIFECYCLE_DISPOSED_CODE = 'RENDERER_HOST_LIFECYCLE_DISPOSED';

class HostLoadFailure {
  readonly cause: unknown;

  constructor(cause: unknown) {
    this.cause = cause;
  }
}

type RendererHostLifecycleState = 'error' | 'running' | 'starting' | 'stopped' | 'stopping';

export interface RendererHostStatusShape {
  readonly active: boolean;
  readonly lastError: string | null;
  readonly runtimeId: string;
  readonly state: RendererHostLifecycleState;
}

interface RendererHostLoadFailureContext {
  readonly errorCode: number;
  readonly errorDescription: string;
  readonly message: string;
  readonly url: string;
  readonly window: BrowserWindow;
}

interface RendererHostProcessGoneContext {
  readonly exitCode: number;
  readonly message: string;
  readonly reason: string;
  readonly window: BrowserWindow;
}

interface RendererHostLifecycleOptions<TStatus extends RendererHostStatusShape> {
  readonly createStatus: (status: RendererHostStatusShape) => TStatus;
  readonly createStoppedStatus: () => TStatus;
  readonly mode: Exclude<DesktopWindowRole, 'visible-ui'>;
  readonly onDidFailLoad?: (context: RendererHostLoadFailureContext) => void;
  readonly onRenderProcessGone?: (context: RendererHostProcessGoneContext) => void;
  readonly onStatusChanged?: (status: TStatus) => void;
  readonly onWindowClosed?: (window: BrowserWindow) => void;
  readonly role: Exclude<DesktopWindowRole, 'visible-ui'>;
  readonly startupQuery?: () => Readonly<Record<string, string>>;
  readonly statusEventName: string;
  /** The refusal of a `waitForStatus` whose caller gave it a bound (`timeoutMs`). */
  readonly timeoutMessage: string;
}

function createLifecycleDisposedError(role: Exclude<DesktopWindowRole, 'visible-ui'>): Error {
  const error = new Error(`${role} lifecycle was disposed while waiting for status.`);
  (
    error as Error & {
      code?: string;
    }
  ).code = RENDERER_HOST_LIFECYCLE_DISPOSED_CODE;
  return error;
}

function isLifecycleDisposedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (
      error as Error & {
        code?: string;
      }
    ).code === RENDERER_HOST_LIFECYCLE_DISPOSED_CODE
  );
}

/**
 * One hidden renderer host window (lifecycle R2/R3). Readiness is the host's own `running` or
 * `error` report, never a clock; death is the window's `closed` or its renderer's
 * `render-process-gone`. A replacement window is created only after the one it replaces has
 * closed, so two renderers of one role never overlap.
 */
export class RendererHostLifecycle<TStatus extends RendererHostStatusShape> {
  private readonly events = new EventEmitter();
  private hostWindow: BrowserWindow | null = null;
  private readonly pendingWaiterRejectors = new Set<(error: Error) => void>();
  private disposed = false;
  /** The `closed` of the windows this lifecycle destroyed and is still waiting on. */
  private retiring: Promise<void> | undefined;
  private startupPromise: Promise<TStatus> | null = null;
  private status: TStatus;

  private readonly options: RendererHostLifecycleOptions<TStatus>;

  constructor(options: RendererHostLifecycleOptions<TStatus>) {
    this.options = options;
    this.status = options.createStoppedStatus();
  }

  getHostWindow(): BrowserWindow | null {
    return this.hostWindow;
  }

  getStatus(): TStatus {
    return this.createStatusSnapshot(this.status);
  }

  isHostWindow(window: BrowserWindow): boolean {
    return this.hostWindow?.id === window.id;
  }

  async ensureStarted(options?: { waitForRunning?: boolean }): Promise<TStatus> {
    if (this.disposed) {
      throw new Error(`${this.options.role} lifecycle has been disposed.`);
    }

    const waitForRunning = options?.waitForRunning ?? true;
    const existingWindow = this.hostWindow;

    if (this.startupPromise) {
      if (!waitForRunning) {
        return this.getStatus();
      }
      return this.startupPromise;
    }

    if (existingWindow && !existingWindow.isDestroyed()) {
      if (this.status.state === 'running') {
        return this.getStatus();
      }
      if (this.status.state === 'starting') {
        if (!waitForRunning) {
          return this.getStatus();
        }
        return this.waitForStatus(
          (status) => status.state === 'running' || status.state === 'error'
        );
      }

      if (this.status.state === 'stopping') {
        // A stop owner is awaiting this window's cooperative 'stopped' report.
        // Replacing the window here would orphan that wait and let the stop then
        // destroy the replacement. Let the stop settle.
        await this.waitForStatus((status) => status.state !== 'stopping');
        return this.ensureStarted(options);
      }

      // An existing hidden host window in stopped/error is not usable for new work.
      // Replace it inside the startup promise so concurrent callers share one restart path.
    }

    const runtimeId = createRuntimeId(this.options.role);
    this.setStatus(
      this.options.createStatus({
        active: false,
        lastError: null,
        runtimeId,
        state: 'starting',
      })
    );

    // startupPromise serializes replacement work, so this snapshot remains valid for the lifetime
    // of the in-flight startup attempt even if later callers arrive while it is pending.
    const shouldReplaceExistingWindow =
      !!existingWindow &&
      !existingWindow.isDestroyed() &&
      existingWindow.id === this.hostWindow?.id;

    this.startupPromise = Promise.resolve().then(async (): Promise<TStatus> => {
      if (shouldReplaceExistingWindow) {
        this.destroyHostWindow();
      }

      try {
        const window = await this.createWindow(runtimeId);
        if (this.disposed) {
          this.clearHostWindow(window);
          if (!window.isDestroyed()) {
            clearWindowRoleByWebContentsId(window.webContents.id);
            window.destroy();
          }
          return this.getStatus();
        }
        this.hostWindow = window;
        this.attachWindow(window);
      } catch (error) {
        return this.settleStartupFailure(error, runtimeId);
      }

      try {
        // Readiness is the host's report (R3); no clock fails it. A closed window or a gone
        // renderer rejects this wait instead.
        return await this.waitForStatus(
          (status) => status.state === 'running' || status.state === 'error'
        );
      } catch (error) {
        if (isLifecycleDisposedError(error)) {
          return this.getStatus();
        }
        const message = error instanceof Error ? error.message : String(error);
        this.setStatus(
          this.options.createStatus({
            active: false,
            lastError: message,
            runtimeId: this.status.runtimeId,
            state: 'error',
          })
        );
        return this.getStatus();
      }
    });
    const startupPromise = this.startupPromise;
    void startupPromise.finally(() => {
      if (this.startupPromise === startupPromise) {
        this.startupPromise = null;
      }
    });

    if (!waitForRunning) {
      return this.getStatus();
    }

    return startupPromise;
  }

  /**
   * Waits for a status matching `predicate`. It rejects when the host window closes, its
   * renderer is gone or the lifecycle is disposed, and, only when the caller bounds its own
   * operation with `timeoutMs` (R5), with `timeoutMessage` at that bound.
   */
  waitForStatus(predicate: (status: TStatus) => boolean, timeoutMs?: number): Promise<TStatus> {
    try {
      if (predicate(this.status)) {
        return Promise.resolve(this.getStatus());
      }
    } catch (error) {
      return Promise.reject(error);
    }

    let release = () => {};
    const wait = Effect.callback<TStatus, Error>((resume) => {
      const rejectPendingWaiter = (error: Error) => resume(Effect.fail(error));
      const listener = (status: TStatus) => {
        let matches = false;
        try {
          matches = predicate(status);
        } catch (error) {
          rejectPendingWaiter(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        if (matches) {
          resume(Effect.sync(() => this.createStatusSnapshot(status)));
        }
      };
      const timeoutId =
        timeoutMs === undefined
          ? undefined
          : setTimeout(
              () => rejectPendingWaiter(new Error(this.options.timeoutMessage)),
              timeoutMs
            );
      release = () => {
        clearTimeout(timeoutId);
        this.pendingWaiterRejectors.delete(rejectPendingWaiter);
        this.events.removeListener(this.options.statusEventName, listener);
      };
      this.pendingWaiterRejectors.add(rejectPendingWaiter);
      this.events.on(this.options.statusEventName, listener);
    });
    return runAtPromiseBoundary(
      Effect.ensuring(
        wait,
        Effect.sync(() => release())
      )
    );
  }

  setStatus(status: TStatus): void {
    const nextStatus = this.createStatusSnapshot(status);
    if (this.areStatusesEqual(this.status, nextStatus)) {
      return;
    }
    this.status = nextStatus;
    const snapshot = this.getStatus();
    this.options.onStatusChanged?.(snapshot);
    this.broadcastStatus(snapshot);
    this.events.emit(this.options.statusEventName, snapshot);
  }

  clearHostWindow(window?: BrowserWindow): void {
    if (window && this.hostWindow?.id !== window.id) {
      return;
    }
    this.hostWindow = null;
  }

  /** Destroys the host window; the next window this lifecycle creates first joins its `closed`. */
  destroyHostWindow(): void {
    const window = this.hostWindow;
    this.hostWindow = null;
    if (window) {
      this.rejectPendingStatusWaiters(
        this.disposed
          ? createLifecycleDisposedError(this.options.role)
          : this.createWindowClosedError()
      );
    }
    if (window && !window.isDestroyed()) {
      clearWindowRoleByWebContentsId(window.webContents.id);
      try {
        void this.destroyAndRetire(window);
      } catch (error) {
        // Still alive: keep owning it, so the next stop retries destroy().
        this.hostWindow = window;
        throw error;
      }
    }
  }

  /**
   * Destroys `window`; the next window this lifecycle creates first joins its `closed`. A
   * `destroy()` that throws leaves the window alive, so its retirement is withdrawn (only its
   * `closed` could settle it) and the error is the caller's.
   */
  private destroyAndRetire(window: BrowserWindow): Promise<void> {
    const previous = this.retiring;
    const closed = this.retire(window);
    try {
      window.destroy();
    } catch (error) {
      this.retiring = previous;
      throw error;
    }
    return closed;
  }

  /** Records the `closed` of a window about to be destroyed; register it before `destroy()`. */
  private retire(window: BrowserWindow): Promise<void> {
    const closed = joinWindowClosed(window);
    const retiring: Promise<void> = Promise.all([this.retiring, closed]).then(() => {
      if (this.retiring === retiring) {
        this.retiring = undefined;
      }
    });
    this.retiring = retiring;
    return closed;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    try {
      this.destroyHostWindow();
    } finally {
      // Any caller already awaiting the previously captured startup promise still needs a concrete
      // disposal signal here; otherwise it would sit until the status wait timeout fires.
      this.startupPromise = null;
      this.rejectPendingStatusWaiters(createLifecycleDisposedError(this.options.role));
      this.events.removeAllListeners();
      this.status = this.options.createStoppedStatus();
    }
  }

  private createWindowClosedError(): Error {
    return new Error(`${this.options.role} window closed before its state transition completed.`);
  }

  private rejectPendingStatusWaiters(error: Error): void {
    for (const rejectPendingWaiter of [...this.pendingWaiterRejectors]) {
      rejectPendingWaiter(error);
    }
    this.pendingWaiterRejectors.clear();
  }

  private settleStartupFailure(error: unknown, runtimeId: string): TStatus {
    if (this.disposed) {
      return this.getStatus();
    }
    this.setStatus(
      this.options.createStatus({
        active: false,
        lastError: error instanceof Error ? error.message : String(error),
        runtimeId,
        state: 'error',
      })
    );
    return this.getStatus();
  }

  private createStatusSnapshot(status: TStatus): TStatus {
    return {
      ...status,
      ...this.options.createStatus(status),
    };
  }

  private buildWindow(): BrowserWindow {
    const isTestMode = process.argv.includes('--test-mode') && !app.isPackaged;
    const enableSandbox = !isTestMode;
    const preloadPath = path.join(resolveDistRoot(), 'hidden-preload.cjs');
    const window = new BrowserWindow({
      focusable: false,
      height: 240,
      show: false,
      skipTaskbar: true,
      webPreferences: {
        additionalArguments: [`--brainstrike-hidden-renderer-role=${this.options.role}`],
        allowRunningInsecureContent: false,
        backgroundThrottling: false,
        contextIsolation: true,
        experimentalFeatures: false,
        navigateOnDragDrop: false,
        nodeIntegration: false,
        preload: preloadPath,
        safeDialogs: true,
        sandbox: enableSandbox,
        webSecurity: true,
      },
      width: 320,
    });

    // Security: Prevent unauthorized window creation by background renderer hosts
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    return window;
  }

  private async loadWindow(
    window: BrowserWindow,
    target: DesktopRendererTarget,
    runtimeId: string
  ): Promise<void> {
    // The hidden hosts load the SAME document as the visible window — the
    // process-wide renderer target `main.ts` configured (BST-1641) — with the
    // role and runtime id as query parameters. Consuming that one object is
    // what keeps the hosts, the visible window, and the IPC sender-frame
    // allowlist in agreement (an earlier bug had this class branch on
    // `app.isPackaged || --test-mode` on its own and point `pnpm start`'s
    // hosts at a dev server that wasn't running).
    const query = { ...this.options.startupQuery?.(), mode: this.options.mode, runtimeId };
    const url = new URL(rendererDocumentUrl(target));
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    await window.loadURL(url.href);
  }

  private async createWindow(runtimeId: string): Promise<BrowserWindow> {
    // Two renderers of one role never overlap: every window this lifecycle destroyed has closed.
    if (this.retiring) {
      await this.retiring;
    }
    // Resolved once, before the retry loop: an unconfigured target is a boot
    // ordering bug, not a transient load failure, so it fails by name here
    // instead of being retried and reported as a generic load error.
    const target = resolveDesktopRendererTarget();
    const owner = this;
    let lastError: Error | null = null;
    let attempt = 0;
    const load = Effect.gen(function* () {
      attempt++;
      if (owner.disposed) {
        throw new Error(`${owner.options.role} lifecycle was disposed during load retry.`);
      }
      const window = owner.buildWindow();
      assignWindowRole(window, owner.options.role);
      // Expose the in-flight window to status-report acceptance BEFORE the
      // page-load await: the host app can mount and send its one-shot
      // 'running' status while loadURL is still pending. If the
      // manager's acceptStatusReport can't see this window yet, that report
      // is dropped and ensureStarted waits out the full ready timeout (then
      // destroys a perfectly healthy host).
      owner.hostWindow = window;
      yield* Effect.tryPromise({
        catch: (error) => new HostLoadFailure(error),
        try: () => owner.loadWindow(window, target, runtimeId),
      }).pipe(
        Effect.catch((failure) =>
          Effect.gen(function* () {
            if (owner.disposed) {
              throw createLifecycleDisposedError(owner.options.role);
            }
            lastError =
              failure.cause instanceof Error ? failure.cause : new Error(String(failure.cause));
            logger.warn(
              `${owner.options.role} failed to load (attempt ${attempt}/${HOST_LOAD_RETRY_ATTEMPTS})`,
              {
                attempt,
                errorMessage: lastError.message,
              }
            );
            owner.clearHostWindow(window);
            clearWindowRoleByWebContentsId(window.webContents.id);
            // The failed window's renderer is released before any retry or later start.
            const closed = owner.destroyAndRetire(window);
            yield* Effect.promise(() => closed);
            return yield* Effect.fail(failure);
          })
        )
      );
      return window;
    });
    try {
      return await runAtPromiseBoundary(
        Effect.retry(load, Schedule.recurs(HOST_LOAD_RETRY_ATTEMPTS - 1))
      );
    } catch (error) {
      if (!(error instanceof HostLoadFailure)) {
        // Construction, disposal, and cleanup failures are terminal defects.
        throw error;
      }
      throw new Error(
        `${this.options.role} failed to load after ${HOST_LOAD_RETRY_ATTEMPTS} attempts`,
        { cause: lastError }
      );
    }
  }

  private attachWindow(window: BrowserWindow): void {
    window.on('closed', () => {
      if (this.hostWindow?.id !== window.id) {
        return;
      }
      this.hostWindow = null;
      this.rejectPendingStatusWaiters(this.createWindowClosedError());
      this.options.onWindowClosed?.(window);
    });

    window.webContents.on('render-process-gone', (_event, details) => {
      if (this.hostWindow?.id !== window.id) {
        return;
      }
      const message = `${this.options.role} renderer exited (${details.reason}, code ${details.exitCode})`;
      this.options.onRenderProcessGone?.({
        exitCode: details.exitCode,
        message,
        reason: details.reason,
        window,
      });
      // R2: a gone renderer never reports again. A wait its owner's report did not settle ends now.
      this.rejectPendingStatusWaiters(new Error(message));
    });

    window.webContents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, url, isMainFrame) => {
        if (!isMainFrame) {
          return;
        }
        if (this.hostWindow?.id !== window.id) {
          return;
        }
        this.options.onDidFailLoad?.({
          errorCode,
          errorDescription,
          message: `${this.options.role} failed to load (${errorCode}): ${errorDescription}`,
          url,
          window,
        });
      }
    );
  }

  private broadcastStatus(snapshot: TStatus): void {
    for (const window of getTrackedWindowsByRole('visible-ui')) {
      try {
        window.webContents.send(this.options.statusEventName, snapshot);
      } catch (error) {
        // Visible renderers can still disappear between registry lookup and send during shutdown.
        logger.debug('Host status broadcast skipped for unavailable window', {
          error,
          targetWindowId: window.id,
          windowRole: 'visible-ui',
        });
      }
    }
  }

  private areStatusesEqual(left: TStatus, right: TStatus): boolean {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    return [...keys].every(
      (key) =>
        JSON.stringify((left as Record<string, unknown>)[key]) ===
        JSON.stringify((right as Record<string, unknown>)[key])
    );
  }
}
