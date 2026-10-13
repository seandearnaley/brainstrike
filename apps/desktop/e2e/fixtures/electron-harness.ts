import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { ElectronApplication, Page, TestInfo } from '@playwright/test';
import type { ElectronAppContext } from '../utils/electron-helpers.mts';
import { ElectronProcessExitGuard } from '../utils/electron-process-exit-guard';
import { loadElectronHelpers } from '../utils/load-electron-helpers';
import type { ModelProviderShim } from '../utils/model-provider-shim';
import { resetToAppHome } from '../utils/test-reset';

interface ElectronHarnessOptions {
  readonly preserveState?: boolean;
}

export class ElectronHarness {
  private app: ElectronApplication | null = null;
  private context: ElectronAppContext | null = null;
  private readonly exitGuard = new ElectronProcessExitGuard();
  private hasProvidedWindow = false;
  private readonly maxRendererRecoveryAttempts = 1;

  constructor(
    private readonly testInfo: TestInfo,
    private readonly debugPort?: number,
    private readonly userDataDir?: string,
    /** Extra environment for every launch of the app, restarts included (never the harness's own). */
    private readonly electronEnv?: Readonly<Record<string, string>>,
    /** Provider egress boundary for every launch, restarts included (BST-1931). */
    private readonly modelProvider?: ModelProviderShim,
    /** The real folder every launch's folder picker mounts by default, restarts included. */
    private readonly workspaceRoot?: string
  ) {}

  getUserDataDir(): string {
    if (!this.userDataDir) {
      throw new Error('Electron harness requires an isolated userDataDir.');
    }
    return this.userDataDir;
  }

  async ensureContext(): Promise<ElectronAppContext> {
    if (!this.context) {
      if (this.app) {
        throw new Error('The harness still owns a failed launch; dispose it before relaunching');
      }
      this.context = await this.launchContext();
      return this.context;
    }

    if (!this.isContextAlive(this.context)) {
      await this.restart();
    }

    return this.context;
  }

  async ensureWindow(options?: ElectronHarnessOptions): Promise<Page> {
    const ctx = await this.ensureContext();
    let page = ctx.window;

    if (!options?.preserveState) {
      page = this.hasProvidedWindow
        ? await this.resetRenderer(page)
        : await this.prepareFreshWindow(page);
    } else if (page.isClosed()) {
      await this.restart();
      return this.ensureWindow({ preserveState: false });
    }

    this.hasProvidedWindow = true;
    return page;
  }

  async restart(): Promise<ElectronAppContext> {
    if (this.app) {
      await this.dispose();
      await new Promise((resolve) => {
        setTimeout(resolve, 250);
      });
    }

    this.context = await this.launchContext();
    this.hasProvidedWindow = false;
    return this.context;
  }

  /**
   * Shuts the app down through the guarded close path so a caller can rewrite
   * on-disk userData state while no Electron process owns it. The next
   * `ensureContext()`/`restart()` launches a fresh process against that state.
   *
   * State-seeding helpers MUST use this instead of calling `closeElectronApp`
   * directly (BST-1087): an out-of-band close never marks the process's exit as
   * intentional, so `ElectronProcessExitGuard` fails the owning test with the
   * process's exit code and signal, and the harness is left holding a context
   * whose `ElectronApplication` is already disposed.
   */
  async closeForStateSeeding(): Promise<void> {
    await this.dispose();
  }

  /**
   * Hands the running app's main process to `end`, which ends it by signal (a signal-shutdown
   * test, a simulated crash) instead of the harness's graceful close. The exit is marked
   * intentional BEFORE `end` runs, so `ElectronProcessExitGuard` does not fail the test for it.
   * The harness keeps the app until the process is confirmed gone: if `end` throws, or returns
   * with the process still running, the process is SIGTERMed and awaited before the failure is
   * rethrown, because the fixture's teardown finds nothing to close once the context is forgotten.
   * If that SIGTERM cannot be confirmed either, the context is kept for the teardown to close, and
   * both errors are thrown together. Afterwards the next `ensureContext()`/`restart()` launches a fresh process on the same userData.
   */
  async endOutOfBand(end: (mainProcess: ChildProcess) => Promise<void>): Promise<void> {
    const context = this.context;
    if (!context) {
      throw new Error('Electron harness has no running app to end.');
    }
    const mainProcess = context.app.process();
    this.exitGuard.beginIntentionalClose(mainProcess);
    try {
      await end(mainProcess);
      if (!hasExited(mainProcess)) {
        throw new Error(
          'endOutOfBand: `end` returned but the Electron main process is still running.'
        );
      }
    } catch (error) {
      try {
        await reapProcess(mainProcess);
      } catch (reapError) {
        // The process may still be alive, so the harness keeps it: the fixture's teardown tries the
        // graceful close again. Both errors are kept, so the reap failure never hides the original.
        throw new AggregateError(
          [error, reapError],
          'endOutOfBand failed and the Electron main process could not be reaped'
        );
      }
      this.forget(context);
      throw error;
    }
    this.forget(context);
  }

  private forget(context: ElectronAppContext): void {
    if (this.context === context) {
      this.context = null;
      this.app = null;
      this.hasProvidedWindow = false;
    }
  }

  /** Closes the app and resolves once its main process has exited; read the exit status afterwards. */
  async dispose(): Promise<void> {
    if (!this.app) {
      return;
    }
    await this.closeAndAssert({ app: this.app });
    this.context = null;
    this.app = null;
    this.hasProvidedWindow = false;
  }

  private async closeAndAssert(context: Pick<ElectronAppContext, 'app'>): Promise<void> {
    let closeError: unknown;
    let closeFailed = false;
    try {
      await this.closeContext(context);
    } catch (error) {
      closeFailed = true;
      closeError = error;
    }

    let healthError: unknown;
    let healthCheckFailed = false;
    try {
      this.exitGuard.assertHealthy();
    } catch (error) {
      healthCheckFailed = true;
      healthError = error;
    }

    if (closeFailed && healthCheckFailed) {
      throw new AggregateError(
        [healthError, closeError],
        'Electron process health check and intentional close both failed'
      );
    }
    if (healthCheckFailed) {
      throw healthError;
    }
    if (closeFailed) {
      throw closeError;
    }
  }

  private async closeContext(context: Pick<ElectronAppContext, 'app'>): Promise<void> {
    const mainProcess = context.app.process();
    this.exitGuard.beginIntentionalClose(mainProcess);
    // Listen before the close request, so the physical exit cannot be missed.
    let onExit = (): void => undefined;
    const exited = hasExited(mainProcess)
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          onExit = resolve;
          mainProcess.once('exit', onExit);
        });
    try {
      const { closeElectronApp } = await loadElectronHelpers();
      await closeElectronApp(context);
      await exited;
    } finally {
      mainProcess.off('exit', onExit);
    }
  }

  private async launchContext(): Promise<ElectronAppContext> {
    const { launchElectronApp } = await loadElectronHelpers();
    const context = await launchElectronApp(this.debugPort, this.userDataDir, {
      disableExternalLocalRuntimeProbes: shouldDisableExternalLocalRuntimeProbes(this.testInfo),
      onAppAcquired: (app) => {
        this.app = app;
        this.exitGuard.observe(app.process());
      },
      ...(this.electronEnv ? { env: this.electronEnv } : {}),
      ...(this.modelProvider ? { modelProvider: this.modelProvider } : {}),
      ...(this.workspaceRoot ? { workspaceRoot: this.workspaceRoot } : {}),
    });
    if (this.app !== context.app) {
      this.app = context.app;
      this.exitGuard.observe(context.app.process());
    }
    return context;
  }

  private async prepareFreshWindow(page: Page): Promise<Page> {
    const { waitForAppReady } = await loadElectronHelpers();
    await waitForAppReady(page);
    await resetToAppHome(page);
    return page;
  }

  private async resetRenderer(page: Page): Promise<Page> {
    return this.resetRendererWithRecovery(page, 0);
  }

  private async resetRendererWithRecovery(page: Page, recoveryAttempt: number): Promise<Page> {
    if (page.isClosed()) {
      return this.restartAndResetRenderer(recoveryAttempt, 'Renderer page was already closed.');
    }

    const { reloadRenderer, resetAppState, waitForAppReady } = await loadElectronHelpers();
    await page.addInitScript(() => {
      (
        window as Window & {
          // biome-ignore lint/style/useNamingConvention: Test-only global flag uses double underscores by convention
          __brainstrike_e2e_expose_file_explorer_store__?: boolean;
        }
      ).__brainstrike_e2e_expose_file_explorer_store__ = true;
    });
    await waitForAppReady(page);

    try {
      await resetAppState(page);
    } catch (error) {
      if (this.isRecoverableRendererError(error)) {
        return this.restartAndResetRenderer(
          recoveryAttempt,
          `Renderer state reset failed due to page crash/closure: ${String(error)}`
        );
      }
      throw error;
    }

    try {
      await reloadRenderer(page, 'playwright-reset-renderer');
    } catch (error) {
      if (this.isRecoverableRendererError(error)) {
        return this.restartAndResetRenderer(
          recoveryAttempt,
          `Renderer reset failed due to page crash/closure: ${String(error)}`
        );
      }
      throw error;
    }

    await resetToAppHome(page);

    return page;
  }

  private isContextAlive(context: ElectronAppContext): boolean {
    if (context.window.isClosed()) {
      return false;
    }

    const process = context.app.process();
    if (process.exitCode !== null || process.killed) {
      return false;
    }

    try {
      return context.app.windows().some((window) => !window.isClosed());
    } catch {
      return false;
    }
  }

  private isRecoverableRendererError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    const normalizedMessage = error.message.toLowerCase();
    return (
      normalizedMessage.includes('page crashed') ||
      normalizedMessage.includes('net::err_file_not_found') ||
      normalizedMessage.includes('target page, context or browser has been closed') ||
      normalizedMessage.includes('navigation failed because page crashed') ||
      normalizedMessage.includes('navigation failed because page was closed')
    );
  }

  private async restartAndResetRenderer(recoveryAttempt: number, reason: string): Promise<Page> {
    if (recoveryAttempt >= this.maxRendererRecoveryAttempts) {
      throw new Error(
        `Renderer reset failed after ${this.maxRendererRecoveryAttempts + 1} attempt(s). ${reason}`
      );
    }

    console.warn(`Restarting Electron app during renderer reset. ${reason}`);
    const restartedContext = await this.restart();
    return this.resetRendererWithRecovery(restartedContext.window, recoveryAttempt + 1);
  }
}

const REAP_TIMEOUT_MS = 10_000;

function hasExited(process: ChildProcess): boolean {
  return process.exitCode !== null || process.signalCode !== null;
}

/** SIGTERMs the process if it is still alive and waits for its exit; a process that will not die is an error. */
async function reapProcess(process: ChildProcess): Promise<void> {
  if (hasExited(process)) {
    return;
  }
  let onExit: () => void = () => undefined;
  let onError: (error: Error) => void = () => undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reaped = new Promise<void>((resolve, reject) => {
    onExit = () => resolve();
    // `kill` throws only for EINVAL/ENOSYS; any other failure (EPERM) is an 'error' event.
    onError = (error) => reject(error);
    timer = setTimeout(() => {
      reject(
        new Error(`The Electron main process did not exit within ${REAP_TIMEOUT_MS}ms of SIGTERM.`)
      );
    }, REAP_TIMEOUT_MS);
  });
  process.once('exit', onExit);
  process.once('error', onError);
  try {
    process.kill('SIGTERM');
    await reaped;
  } finally {
    clearTimeout(timer);
    process.off('exit', onExit);
    process.off('error', onError);
  }
}

function shouldDisableExternalLocalRuntimeProbes(testInfo: TestInfo): boolean {
  return !testInfo.file.endsWith(`${path.sep}local-runtime-probe.desktop.test.ts`);
}
