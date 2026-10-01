import { describe, expect, it, vi } from 'vitest';
import {
  registerEmbeddingRuntimeConfig,
  resetEmbeddingRuntimeConfig,
} from '../../embeddings/src/runtime-config';
import { TransformersBackend } from '../../embeddings/src/transformers-backend';

const helperUrl = new URL('../src/model-download.ts', import.meta.url).href;

/** A tiny public factory fixture; its live heartbeat independently observes worker lifetime. */
function workerFixture(channelName: string): string {
  return `
    import { downloadEmbeddingModelArtifacts } from ${JSON.stringify(helperUrl)};
    self.onmessage = async ({ data: { request } }) => {
      const channel = new BroadcastChannel(${JSON.stringify(channelName)});
      const release = Promise.withResolvers();
      channel.onmessage = () => {
        if (request.model === 'runtime') throw new Error('worker startup failed');
        release.resolve();
      };
      if (request.model === 'runtime') {
        setInterval(() => channel.postMessage('alive'), 20);
        return;
      }
      setInterval(() => channel.postMessage('alive'), 20);
      const pipeline = async () => {
        if (request.model === 'factory') {
          await release.promise;
          throw new Error('factory failed');
        }
        return { dispose: async () => {
          await release.promise;
          throw new Error('session release failed');
        }};
      };
      try {
        await downloadEmbeddingModelArtifacts(request, pipeline, () => {});
        self.postMessage({ id: request.id, type: 'download-complete' });
      } catch (error) {
        self.postMessage({ id: request.id, type: 'download-error', message: error.message });
      }
    };
  `;
}

describe('physical download worker ownership in Chromium', () => {
  it.each(['factory', 'disposal', 'runtime'])(
    'terminates the real worker after %s failure',
    async (mode) => {
      const channelName = `download-owner-${crypto.randomUUID()}`;
      const channel = new BroadcastChannel(channelName);
      let heartbeats = 0;
      channel.onmessage = () => {
        heartbeats += 1;
      };
      const workerUrl = URL.createObjectURL(
        new Blob([workerFixture(channelName)], { type: 'text/javascript' })
      );
      registerEmbeddingRuntimeConfig({ streamingWorkerUrl: workerUrl });
      const backend = new TransformersBackend();
      const download = backend.downloadModel(mode);
      try {
        await vi.waitFor(() => expect(heartbeats).toBeGreaterThan(0));
        channel.postMessage('fail');
        const errorMessage =
          mode === 'runtime'
            ? 'worker startup failed'
            : mode === 'factory'
              ? 'factory failed'
              : 'session release failed';
        await expect(download).rejects.toThrow(errorMessage);
        // Allow any already-posted message to arrive before observing the retired worker.
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        const retiredCount = heartbeats;
        await new Promise<void>((resolve) => setTimeout(resolve, 150));
        expect(heartbeats).toBe(retiredCount);
      } finally {
        await backend.dispose();
        channel.close();
        URL.revokeObjectURL(workerUrl);
        resetEmbeddingRuntimeConfig();
      }
    }
  );
});
