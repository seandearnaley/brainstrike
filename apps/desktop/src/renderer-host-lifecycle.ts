import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { BoundaryFailureError, processLost } from '@brainstrike/assistant-contract';
import { runAtPromiseBoundary } from '@brainstrike/effect-kit';
import { createLogger } from '@brainstrike/logging';
import { createRuntimeId } from '@brainstrike/worker-runtime';
import { Effect } from 'effect';
import { app, BrowserWindow, type Event, type RenderProcessGoneDetails } from 'electron';
import {
  type ChildGenerationContext,
  type ChildResource,
  createChildSupervisor,
} from './child-supervisor';
import {
  type DesktopRendererTarget,
  resolveDesktopRendererTarget,
} from './desktop-renderer-target';
import { resolveDistRoot } from './dist-root';
import {
  assignWindowRole,
  clearWindowRoleByWebContentsId,
  type DesktopWindowRole,
  getTrackedWindowsByRole,
} from './window-role';

const DEFAULT_HOST_READY_TIMEOUT_MS = 30_000;
const logger = createLogger('RendererHostLifecycle');
const RENDERER_HOST_LIFECYCLE_DISPOSED_CODE = 'RENDERER_HOST_LIFECYCLE_DISPOSED';

export type RendererHostLifecycleState = 'error' | 'running' | 'starting' | 'stopped' | 'stopping';

export interface RendererHostStatusShape {
  readonly active: boolean;
  readonly lastError: string | null;
  readonly runtimeId: string;
  readonly state: RendererHostLifecycleState;
}

export interface RendererHostLoadFailureContext {
  readonly errorCode: number;
  readonly errorDescription: string;
  readonly message: string;
  readonly url: string;
  readonly window: BrowserWindow;
}

export interface RendererHostProcessGoneContext {
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

class RendererHostStop extends Error {
  constructor(readonly protocol: () => Promise<void>) {
    super('Explicit hidden renderer stop');
  }
}

export class RendererHostLifecycle<TStatus extends RendererHostStatusShape> {
  private readonly events = new EventEmitter();
  private host: {
    readonly window: BrowserWindow;
    readonly context: ChildGenerationContext;
    readonly closed: Promise<void>;
  } | null = null;
  private readonly supervisor = createChildSupervisor<TStatus>({
    create: (context) => this.createResource(context),
    restart: 'lazy',
  });
  private readonly pendingWaiterRejectors = new Set<(error: Error) => void>();
  private disposed = false;
  private status: TStatus;

  constructor(private readonly options: RendererHostLifecycleOptions<TStatus>) {
    this.status = options.createStoppedStatus();
  }

  getHostWindow(): BrowserWindow | null {
    return this.host?.window ?? null;
  }

  getStatus(): TStatus {
    return this.createStatusSnapshot(this.status);
  }

  isHostWindow(window: BrowserWindow): boolean {
    return this.host?.window.id === window.id;
  }

  async ensureStarted(options?: { waitForRunning?: boolean }): Promise<TStatus> {
    if (this.disposed) {
      throw createLifecycleDisposedError(this.options.role);
    }
    const child = await this.supervisor;
    try {
      const admitted = await child.start({ afterStop: true });
      const ready = admitted.ready
        .catch(async (cause: unknown) => {
          // Only the sole owner's recorded physical loss admits the one replacement.
          if ((await child.snapshot()).kind === 'lost') {
            return child.acquire();
          }
          throw cause;
        })
        .catch((cause: unknown) => this.retireStartupFailure(cause));
      if (options?.waitForRunning === false) {
        void ready;
        return this.getStatus();
      }
      await ready;
      return this.getStatus();
    } catch (cause) {
      return this.retireStartupFailure(cause);
    }
  }

  /** Explicit Start/Reset action; passive acquisition cannot rearm a failed child. */
  async restart(): Promise<TStatus> {
    if (this.disposed) {
      throw createLifecycleDisposedError(this.options.role);
    }
    await (await this.supervisor).restart();
    return this.getStatus();
  }

  waitForStatus(predicate: (status: TStatus) => boolean, timeoutMs: number): Promise<TStatus> {
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
      const timeoutId = setTimeout(
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

  /** The manager writes its protocol; the supervisor owns its complete release join. */
  async stop(protocol: () => Promise<void> = async () => {}): Promise<void> {
    await (await this.supervisor).stop(new RendererHostStop(protocol));
  }

  acceptsStatus(senderId: number, status: RendererHostStatusShape): boolean {
    const host = this.host;
    if (!host || host.window.isDestroyed() || host.window.webContents.id !== senderId) {
      return false;
    }
    if (!host.context.signal.aborted) {
      return true;
    }
    return (
      status.runtimeId === this.status.runtimeId &&
      (status.state === 'stopped' || status.state === 'error')
    );
  }

  /** The physical resource's receipt, also borrowed by pending inference settlement. */
  joinPhysicalClose(): Promise<void> {
    return this.host?.closed ?? Promise.resolve();
  }

  /** Failure retirement preserves the owner's loss/budget; it is not an explicit Stop. */
  async retire(cause: unknown, runtimeId?: string): Promise<void> {
    const host = this.host;
    if (runtimeId !== undefined && (!host || this.status.runtimeId !== runtimeId)) {
      return;
    }
    if (host && !host.context.signal.aborted) {
      await host.context.lost(cause);
    }
    await (await this.supervisor).retireLost();
  }

  async destroyHostWindow(): Promise<void> {
    const cause = this.disposed
      ? createLifecycleDisposedError(this.options.role)
      : this.createWindowClosedError();
    this.rejectPendingStatusWaiters(cause);
    await (await this.supervisor).stop(cause);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.rejectPendingStatusWaiters(createLifecycleDisposedError(this.options.role));
    await this.destroyHostWindow();
    this.events.removeAllListeners();
    this.status = this.options.createStoppedStatus();
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

  private async retireStartupFailure(cause: unknown): Promise<TStatus> {
    let failure = cause;
    try {
      await (await this.supervisor).retireLost();
    } catch (cleanup) {
      failure = new AggregateError(
        [cause, cleanup],
        'Hidden renderer startup and retirement failed.'
      );
    }
    return this.settleStartupFailure(failure, this.status.runtimeId);
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
    const preloadPath = path.join(resolveDistRoot(), 'hidden-preload.js');
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
    if (target.kind === 'built-renderer') {
      await window.loadFile(target.rendererPath, {
        query,
      });
      return;
    }
    await window.loadURL(`${target.url}?${new URLSearchParams(query).toString()}`);
  }

  private createResource(context: ChildGenerationContext): ChildResource<TStatus> {
    // Target/configuration and construction failures are not retryable child losses.
    const target = resolveDesktopRendererTarget();
    const runtimeId = createRuntimeId(this.options.role);
    this.setStatus(
      this.options.createStatus({ active: false, lastError: null, runtimeId, state: 'starting' })
    );
    const window = this.buildWindow();
    const contents = window.webContents;
    const physical = Promise.withResolvers<void>();
    assignWindowRole(window, this.options.role);
    this.host = { closed: physical.promise, context, window };
    const current = (): boolean => this.host?.window === window;
    const lost = (cause: unknown): void => {
      if (!context.signal.aborted) {
        void context.lost(cause).catch((error: unknown) => {
          logger.error('Hidden renderer loss could not be settled', {
            error,
            windowRole: this.options.role,
          });
        });
      }
    };
    const onClosed = (): void => {
      physical.resolve();
      clearWindowRoleByWebContentsId(contents.id);
      if (!current()) {
        return;
      }
      this.host = null;
      this.rejectPendingStatusWaiters(this.createWindowClosedError());
      if (!context.signal.aborted) {
        const cause = this.processFailure({ reason: 'window-closed' });
        this.options.onWindowClosed?.(window);
        lost(cause);
      }
    };
    const onGone = (_event: Event, details: RenderProcessGoneDetails): void => {
      physical.resolve();
      if (!current()) {
        return;
      }
      if (context.signal.aborted) {
        if (this.pendingWaiterRejectors.size > 0) {
          this.rejectPendingStatusWaiters(
            this.processFailure({ exitCode: details.exitCode, reason: details.reason })
          );
        }
        return;
      }
      const message = `${this.options.role} renderer exited (${details.reason}, code ${details.exitCode})`;
      this.options.onRenderProcessGone?.({
        exitCode: details.exitCode,
        message,
        reason: details.reason,
        window,
      });
      const cause = this.processFailure({ exitCode: details.exitCode, reason: details.reason });
      this.rejectPendingStatusWaiters(cause);
      lost(cause);
    };
    const onLoadFailed = (
      _event: Event,
      errorCode: number,
      errorDescription: string,
      url: string,
      isMainFrame: boolean
    ): void => {
      if (!(isMainFrame && current()) || context.signal.aborted) {
        return;
      }
      this.options.onDidFailLoad?.({
        errorCode,
        errorDescription,
        message: `${this.options.role} failed to load (${errorCode}): ${errorDescription}`,
        url,
        window,
      });
    };
    window.on('closed', onClosed);
    contents.on('render-process-gone', onGone);
    contents.on('did-fail-load', onLoadFailed);
    const close = async (reason: unknown): Promise<void> => {
      const failures: unknown[] = [];
      if (reason instanceof RendererHostStop && !window.isDestroyed()) {
        try {
          await reason.protocol();
        } catch (cause) {
          failures.push(cause);
        }
      }
      this.rejectPendingStatusWaiters(
        context.signal.reason instanceof Error
          ? context.signal.reason
          : this.createWindowClosedError()
      );
      try {
        if (!window.isDestroyed()) {
          window.destroy();
        }
      } catch (cause) {
        failures.push(cause);
        throw failures.length === 1
          ? cause
          : new AggregateError(failures, 'Hidden renderer stop and destruction failed.');
      }
      await physical.promise;
      window.removeListener('closed', onClosed);
      contents.removeListener('render-process-gone', onGone);
      contents.removeListener('did-fail-load', onLoadFailed);
      clearWindowRoleByWebContentsId(contents.id);
      if (current()) {
        this.host = null;
      }
      if (failures.length > 0) {
        throw failures[0];
      }
    };
    const ready = this.loadWindow(window, target, runtimeId)
      .catch(async (cause: unknown) => {
        if (!context.signal.aborted) {
          await context.lost(cause);
        }
        throw cause;
      })
      .then(async () => {
        context.signal.throwIfAborted();
        const status = await this.waitForStatus(
          (next) => next.state === 'running' || next.state === 'error',
          DEFAULT_HOST_READY_TIMEOUT_MS
        );
        if (status.state === 'error') {
          throw new Error(status.lastError ?? this.options.timeoutMessage);
        }
        return status;
      });
    return { close, ready };
  }

  private processFailure(facts: {
    readonly exitCode?: number;
    readonly reason: string;
  }): BoundaryFailureError {
    const failure = {
      ...processLost({ child: this.options.role, ...facts }),
      correlationId: randomUUID(),
    };
    logger.error('Hidden renderer process lost', {
      ...facts,
      correlationId: failure.correlationId,
      windowRole: this.options.role,
    });
    return new BoundaryFailureError(failure);
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
