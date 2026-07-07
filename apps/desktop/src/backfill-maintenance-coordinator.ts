import { createLogger } from '@brainstrike/utils/logger';
import type { EmbeddingHostStatus } from './embedding-host-shared';

const logger = createLogger('BackfillMaintenanceCoordinator');

export type GpuMemoryReclaimMode = 'reset';

export interface GpuMemoryReclaimConfig {
  enabled: boolean;
  itemThreshold: number;
  minimumIntervalMs: number;
  mode: GpuMemoryReclaimMode;
}

interface EmbeddingHostMaintenanceControl {
  reset: () => Promise<EmbeddingHostStatus>;
}

type BackfillMaintenanceState = 'failed' | 'idle' | 'requested' | 'running';

export interface BackfillMaintenanceDiagnostics {
  completedSinceLastMaintenance: number;
  cycleCount: number;
  enabled: boolean;
  lastError: string | null;
  minimumIntervalMs: number;
  mode: GpuMemoryReclaimMode;
  state: BackfillMaintenanceState;
}

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

/**
 * Coordinates planned embedding-host maintenance from backfill drain-safe checkpoints only.
 *
 * Invariants:
 * - Maintenance requests are accumulated from completed-item deltas, never wall-clock polling.
 * - Host reset transitions are only tolerated while planned maintenance is actively running.
 * - Once maintenance fails, the backfill must fail fast with the recorded maintenance error.
 */
export class BackfillMaintenanceCoordinator {
  private completedSinceLastMaintenance = 0;
  private lastMaintenanceCompletedAt = 0;
  private maintenanceError: Error | null = null;
  private reclaimCycleCount = 0;
  private state: BackfillMaintenanceState = 'idle';

  constructor(
    private readonly config: GpuMemoryReclaimConfig,
    private readonly embeddingSetId: string,
    private readonly hostManager: EmbeddingHostMaintenanceControl,
    private readonly now: () => number = Date.now
  ) {}

  getReclaimCycleCount(): number {
    return this.reclaimCycleCount;
  }

  getState(): BackfillMaintenanceState {
    return this.state;
  }

  getDiagnostics(): BackfillMaintenanceDiagnostics {
    return {
      completedSinceLastMaintenance: this.completedSinceLastMaintenance,
      cycleCount: this.reclaimCycleCount,
      enabled: this.config.enabled,
      lastError: this.maintenanceError?.message ?? null,
      minimumIntervalMs: this.config.minimumIntervalMs,
      mode: this.config.mode,
      state: this.state,
    };
  }

  noteCompletedItems(completedSinceLastTick: number): void {
    if (!Number.isInteger(completedSinceLastTick) || completedSinceLastTick < 0) {
      throw new Error('completedSinceLastTick must be a non-negative integer.');
    }
    if (completedSinceLastTick === 0 || !this.config.enabled) {
      return;
    }
    if (this.state === 'failed' && this.maintenanceError) {
      throw this.createMaintenanceFailure(this.maintenanceError);
    }

    this.completedSinceLastMaintenance += completedSinceLastTick;
    if (this.state === 'idle' && this.completedSinceLastMaintenance >= this.config.itemThreshold) {
      this.state = 'requested';
      logger.info('Requested embedding host GPU reclaim maintenance', {
        completedSinceLastMaintenance: this.completedSinceLastMaintenance,
        embeddingSetId: this.embeddingSetId,
        mode: this.config.mode,
        threshold: this.config.itemThreshold,
      });
    }
  }

  assertCanContinue(status: Pick<EmbeddingHostStatus, 'lastError' | 'state'>): void {
    if (this.state === 'failed' && this.maintenanceError) {
      throw this.createMaintenanceFailure(this.maintenanceError);
    }
    if (this.state === 'requested' || this.state === 'running') {
      return;
    }
    if (status.state === 'error') {
      throw new Error(status.lastError ?? 'Embedding host entered an error state during backfill.');
    }
    if (status.state === 'stopped' || status.state === 'stopping' || status.state === 'starting') {
      throw new Error('Embedding host stopped while backfill was in progress.');
    }
  }

  async runRequestedMaintenance(): Promise<void> {
    if (!this.config.enabled || this.state !== 'requested') {
      if (this.state === 'failed' && this.maintenanceError) {
        throw this.createMaintenanceFailure(this.maintenanceError);
      }
      return;
    }
    if (!this.isMaintenanceIntervalSatisfied()) {
      return;
    }

    this.state = 'running';
    const reclaimCycle = this.reclaimCycleCount + 1;

    logger.info('Starting embedding host maintenance during backfill drain', {
      completedSinceLastMaintenance: this.completedSinceLastMaintenance,
      embeddingSetId: this.embeddingSetId,
      mode: this.config.mode,
      reclaimCycle,
    });

    try {
      const status = await this.hostManager.reset();
      if (status.state !== 'running') {
        throw new Error(
          status.lastError ??
            `Embedding host GPU reclaim maintenance did not return to running for mode "${this.config.mode}".`
        );
      }

      this.completedSinceLastMaintenance = 0;
      this.lastMaintenanceCompletedAt = this.now();
      this.reclaimCycleCount = reclaimCycle;
      this.state = 'idle';
      logger.info('Completed embedding host GPU reclaim maintenance', {
        embeddingSetId: this.embeddingSetId,
        mode: this.config.mode,
        reclaimCycle,
      });
    } catch (error) {
      const maintenanceError = toError(error);
      this.maintenanceError = maintenanceError;
      this.state = 'failed';
      logger.error('Embedding host GPU reclaim maintenance failed', {
        embeddingSetId: this.embeddingSetId,
        error: maintenanceError.message,
        mode: this.config.mode,
        reclaimCycle,
      });
      throw this.createMaintenanceFailure(maintenanceError);
    }
  }

  private createMaintenanceFailure(error: Error): Error {
    return new Error(`Embedding host GPU reclaim maintenance failed: ${error.message}`, {
      cause: error,
    });
  }

  private isMaintenanceIntervalSatisfied(): boolean {
    if (this.lastMaintenanceCompletedAt === 0) {
      return true;
    }
    return this.now() - this.lastMaintenanceCompletedAt >= this.config.minimumIntervalMs;
  }
}
