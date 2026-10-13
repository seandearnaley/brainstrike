import type { EmbeddingHostCommand, EmbeddingHostStatus } from './embedding-host-shared';
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
  query(): Readonly<Record<string, string>> {
    return { embeddingStart: 'on-demand' };
  }

  async ensure(owner: StartupOwner): Promise<EmbeddingHostStatus> {
    owner.assertCurrent();
    return await owner.lifecycle.ensureStarted(owner.options);
  }
}
