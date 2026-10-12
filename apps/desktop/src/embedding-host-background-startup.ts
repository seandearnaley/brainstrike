import {
  createEmbeddingHostCommand,
  type EmbeddingHostCommand,
  type EmbeddingHostStatus,
} from './embedding-host-shared';
import type { RendererHostLifecycle } from './renderer-host-lifecycle';

interface StartupOwner {
  assertCurrent(): void;
  readonly backgroundWorker: boolean;
  readonly lifecycle: RendererHostLifecycle<EmbeddingHostStatus>;
  readonly options: { waitForRunning?: boolean } | undefined;
  send(command: EmbeddingHostCommand): void;
  stopping(): Promise<EmbeddingHostStatus> | null;
  readonly timeoutMs: number;
}

/** Admission state for one hidden renderer; native plans never configure its legacy worker. */
export class EmbeddingHostStartup {
  private backgroundWorkerRequested = true;
  private backgroundStartup: Promise<EmbeddingHostStatus> | null = null;

  query(): Readonly<Record<string, string>> {
    return this.backgroundWorkerRequested ? {} : { embeddingStart: 'on-demand' };
  }

  async ensure(owner: StartupOwner): Promise<EmbeddingHostStatus> {
    const { lifecycle, options, backgroundWorker } = owner;
    const current = lifecycle.getStatus();
    if (current.state === 'stopped' || current.state === 'error') {
      this.backgroundWorkerRequested = backgroundWorker;
    }
    const started = await lifecycle.ensureStarted(
      backgroundWorker && !this.backgroundWorkerRequested ? { waitForRunning: true } : options
    );
    if (!backgroundWorker) {
      return started;
    }
    if (this.backgroundStartup) {
      return this.backgroundStartup;
    }
    if (this.backgroundWorkerRequested || started.state !== 'running') {
      return started;
    }
    // Enable the existing owner instead of resetting native inference in flight.
    this.backgroundWorkerRequested = true;
    const command = createEmbeddingHostCommand('start-background', started.runtimeId);
    owner.assertCurrent();
    const completion = (async (): Promise<EmbeddingHostStatus> => {
      owner.send(command);
      const acknowledged = await lifecycle.waitForStatus(
        (next) =>
          next.state === 'stopping' ||
          next.state === 'stopped' ||
          next.runtimeId !== started.runtimeId ||
          (next.commandId === command.requestId &&
            (next.state === 'running' || next.state === 'error')),
        owner.timeoutMs
      );
      const stopping = owner.stopping();
      if (stopping) {
        return await stopping;
      }
      if (acknowledged.runtimeId !== started.runtimeId || acknowledged.state === 'stopped') {
        throw new Error('Embedding host changed during background startup.');
      }
      return acknowledged;
    })();
    this.backgroundStartup = completion;
    try {
      return await completion;
    } finally {
      if (this.backgroundStartup === completion) {
        this.backgroundStartup = null;
      }
    }
  }
}
