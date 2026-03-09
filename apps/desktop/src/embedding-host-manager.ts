import { createLogger } from '@brainstrike/utils';
import { type BrowserWindow, powerSaveBlocker } from 'electron';
import {
  createEmbeddingHostCommand,
  createStoppedEmbeddingHostStatus,
  EMBEDDING_HOST_COMMAND_EVENT,
  EMBEDDING_HOST_STATUS_ADAPTER,
  EMBEDDING_HOST_STATUS_EVENT,
  type EmbeddingHostStatus,
  type EmbeddingHostStatusReport,
} from './embedding-host-shared';
import { RendererHostLifecycle } from './renderer-host-lifecycle';

const logger = createLogger('EmbeddingHostManager');

const HOST_READY_TIMEOUT_MS = 30_000;
const POWER_SAVE_BLOCKER_IDLE_GRACE_MS = 5000;

export class EmbeddingHostManager {
  private readonly lifecycle: RendererHostLifecycle<EmbeddingHostStatus>;
  private powerSaveBlockerId: number | null = null;
  private pendingIdleStopTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.lifecycle = new RendererHostLifecycle<EmbeddingHostStatus>({
      createStatus: EMBEDDING_HOST_STATUS_ADAPTER.createStatus,
      createStoppedStatus: createStoppedEmbeddingHostStatus,
      mode: 'embedding-host',
      onDidFailLoad: ({ errorCode, errorDescription, message, url }) => {
        logger.error(message, { errorCode, errorDescription, url, windowRole: 'embedding-host' });
        this.lifecycle.setStatus(
          EMBEDDING_HOST_STATUS_ADAPTER.createStatus({
            state: 'error',
            active: false,
            lastError: message,
            runtimeId: this.getStatus().runtimeId,
          })
        );
      },
      onRenderProcessGone: ({ exitCode, message, reason }) => {
        logger.error(message, {
          reason,
          exitCode,
          windowRole: 'embedding-host',
        });
        this.lifecycle.setStatus(
          EMBEDDING_HOST_STATUS_ADAPTER.createStatus({
            state: 'error',
            active: false,
            lastError: message,
            runtimeId: this.getStatus().runtimeId,
          })
        );
      },
      onStatusChanged: (status) => {
        this.syncPowerSaveBlocker(status);
      },
      onWindowClosed: () => {
        this.lifecycle.setStatus(createStoppedEmbeddingHostStatus());
      },
      role: 'embedding-host',
      statusEventName: EMBEDDING_HOST_STATUS_EVENT,
      timeoutMessage: 'Timed out waiting for embedding host state transition.',
    });
  }

  getStatus(): EmbeddingHostStatus {
    return this.lifecycle.getStatus();
  }

  isHostWindow(window: BrowserWindow): boolean {
    return this.lifecycle.isHostWindow(window);
  }

  async ensureStarted(options?: { waitForRunning?: boolean }): Promise<EmbeddingHostStatus> {
    return this.lifecycle.ensureStarted(options);
  }

  async stop(): Promise<EmbeddingHostStatus> {
    const window = this.lifecycle.getHostWindow();
    if (!window || window.isDestroyed()) {
      this.lifecycle.clearHostWindow();
      this.lifecycle.setStatus(createStoppedEmbeddingHostStatus());
      return this.getStatus();
    }

    this.lifecycle.setStatus(
      EMBEDDING_HOST_STATUS_ADAPTER.createStatus({
        state: 'stopping',
        active: false,
        lastError: null,
        runtimeId: this.getStatus().runtimeId,
      })
    );

    window.webContents.send(
      EMBEDDING_HOST_COMMAND_EVENT,
      createEmbeddingHostCommand('stop', this.getStatus().runtimeId)
    );

    try {
      return await this.lifecycle.waitForStatus((status) => status.state === 'stopped', 10_000);
    } catch {
      this.lifecycle.destroyHostWindow();
      this.lifecycle.setStatus(createStoppedEmbeddingHostStatus());
      return this.getStatus();
    }
  }

  async reset(): Promise<EmbeddingHostStatus> {
    const window = this.lifecycle.getHostWindow();
    if (!window || window.isDestroyed()) {
      return this.ensureStarted();
    }

    this.lifecycle.setStatus(
      EMBEDDING_HOST_STATUS_ADAPTER.createStatus({
        state: 'starting',
        active: false,
        lastError: null,
        runtimeId: this.getStatus().runtimeId,
      })
    );

    window.webContents.send(
      EMBEDDING_HOST_COMMAND_EVENT,
      createEmbeddingHostCommand('reset', this.getStatus().runtimeId)
    );
    try {
      return await this.lifecycle.waitForStatus(
        (status) => status.state === 'running' || status.state === 'error',
        HOST_READY_TIMEOUT_MS
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lifecycle.setStatus(
        EMBEDDING_HOST_STATUS_ADAPTER.createStatus({
          state: 'error',
          active: false,
          lastError: message,
          runtimeId: this.getStatus().runtimeId,
        })
      );
      return this.getStatus();
    }
  }

  async dispose(): Promise<void> {
    try {
      await this.stop();
    } finally {
      this.lifecycle.destroyHostWindow();
      this.stopPowerSaveBlocker();
      this.lifecycle.dispose();
    }
  }

  acceptStatusReport(senderId: number, report: EmbeddingHostStatusReport): void {
    const window = this.lifecycle.getHostWindow();
    if (!window || window.isDestroyed()) {
      return;
    }
    if (window.webContents.id !== senderId) {
      logger.warn('Rejected embedding host status report from unknown renderer', { senderId });
      return;
    }
    this.lifecycle.setStatus(
      EMBEDDING_HOST_STATUS_ADAPTER.createStatus({
        state: report.state,
        active: report.active,
        lastError: report.lastError,
        runtimeId: report.runtimeId,
      })
    );
  }

  private syncPowerSaveBlocker(status: EmbeddingHostStatus): void {
    const shouldBlock = status.state === 'running' && status.active;
    if (shouldBlock) {
      this.clearPendingIdleStop();
      if (this.powerSaveBlockerId === null) {
        this.powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension');
        logger.info('powerSaveBlocker started for active embedding host work', {
          id: this.powerSaveBlockerId,
          runtimeId: status.runtimeId,
        });
      }
      return;
    }

    if (status.state === 'running') {
      this.scheduleIdleStop();
      return;
    }

    this.stopPowerSaveBlocker();
  }

  private scheduleIdleStop(): void {
    if (this.powerSaveBlockerId === null || this.pendingIdleStopTimer !== null) {
      return;
    }

    this.pendingIdleStopTimer = setTimeout(() => {
      this.pendingIdleStopTimer = null;
      this.stopPowerSaveBlocker();
    }, POWER_SAVE_BLOCKER_IDLE_GRACE_MS);
  }

  private clearPendingIdleStop(): void {
    if (this.pendingIdleStopTimer === null) {
      return;
    }
    clearTimeout(this.pendingIdleStopTimer);
    this.pendingIdleStopTimer = null;
  }

  private stopPowerSaveBlocker(): void {
    this.clearPendingIdleStop();
    if (this.powerSaveBlockerId === null) {
      return;
    }
    if (powerSaveBlocker.isStarted(this.powerSaveBlockerId)) {
      powerSaveBlocker.stop(this.powerSaveBlockerId);
      logger.info('powerSaveBlocker stopped for idle embedding host', {
        id: this.powerSaveBlockerId,
        runtimeId: this.getStatus().runtimeId,
      });
    }
    this.powerSaveBlockerId = null;
  }
}
