import { createLogger } from '@brainstrike/utils/logger';
import type { LocalLlmModelSpec } from './local-model-specs';
import type { LocalLlmProgressCallback } from './types';

const logger = createLogger('LocalArtifactStore');
const TRANSFORMERS_CACHE_NAME = 'transformers-cache';
const QUOTA_SAFETY_BUFFER = 1.1;

export interface LocalArtifactStore {
  download(spec: LocalLlmModelSpec, onProgress?: LocalLlmProgressCallback): Promise<void>;
  hasRequiredArtifacts(spec: LocalLlmModelSpec): Promise<boolean>;
}

function resolveHubBaseUrl(): string {
  if (typeof window === 'undefined') {
    return 'https://huggingface.co';
  }

  if (window.location.protocol === 'file:') {
    return 'https://huggingface.co';
  }

  return '/api/hf';
}

export function buildLocalArtifactUrl(
  modelId: string,
  revision: string,
  relativePath: string
): string {
  const base = resolveHubBaseUrl().replace(/\/+$/, '');
  return `${base}/${modelId}/resolve/${revision}/${relativePath}`;
}

async function openArtifactCache(): Promise<Cache> {
  return await caches.open(TRANSFORMERS_CACHE_NAME);
}

async function checkStorageQuota(requiredBytes: number): Promise<void> {
  if (
    typeof navigator === 'undefined' ||
    !('storage' in navigator) ||
    typeof navigator.storage?.estimate !== 'function'
  ) {
    return;
  }

  const estimate = await navigator.storage.estimate();
  const available = (estimate.quota ?? 0) - (estimate.usage ?? 0);
  const requiredWithBuffer = Math.ceil(requiredBytes * QUOTA_SAFETY_BUFFER);
  if (available < requiredWithBuffer) {
    throw new Error(
      `storage_insufficient: need ${requiredWithBuffer} bytes, only ${available} bytes available`
    );
  }
}

function toProgressPercent(completed: number, total: number, partial = 0): number {
  if (total <= 0) {
    return 0;
  }
  return Math.round(((completed + partial) / total) * 100);
}

async function cacheResponseStream(
  cache: Cache,
  url: string,
  response: Response,
  onChunkProgress: (loaded: number, total: number | null) => void
): Promise<void> {
  if (!response.body) {
    await cache.put(url, response.clone());
    onChunkProgress(1, 1);
    return;
  }

  const [cacheStream, progressStream] = response.body.tee();
  const cachePut = cache.put(
    url,
    new Response(cacheStream, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    })
  );

  const totalHeader = response.headers.get('content-length');
  const total = totalHeader ? Number.parseInt(totalHeader, 10) : null;
  const reader = progressStream.getReader();
  let loaded = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    loaded += value.byteLength;
    onChunkProgress(loaded, Number.isFinite(total) ? total : null);
  }

  await cachePut;
}

export class BrowserCacheArtifactStore implements LocalArtifactStore {
  async download(spec: LocalLlmModelSpec, onProgress?: LocalLlmProgressCallback): Promise<void> {
    const files = [...spec.artifacts.text];
    await checkStorageQuota(spec.totalSizeBytes);

    const cache = await openArtifactCache();
    let completed = 0;

    for (const filePath of files) {
      const url = buildLocalArtifactUrl(spec.modelId, spec.remoteRevision, filePath);
      const cached = await cache.match(url);
      if (cached) {
        completed += 1;
        continue;
      }

      const response = await fetch(url, {
        headers: {
          accept: '*/*',
        },
      });
      if (!response.ok) {
        throw new Error(`artifact_download_failed: ${filePath} returned ${response.status}`);
      }

      await cacheResponseStream(cache, url, response, (loaded, total) => {
        const partial = total && total > 0 ? loaded / total : 0;
        onProgress?.({
          stage: 'downloading',
          progress: toProgressPercent(completed, files.length, partial),
          message: `Downloading ${filePath}`,
          file: filePath,
        });
      });

      completed += 1;
    }

    onProgress?.({
      stage: 'ready',
      progress: 100,
      message: 'Model downloaded',
    });
    logger.info('Local artifacts downloaded', {
      modelId: spec.modelId,
      filesDownloaded: files.length,
    });
  }

  async hasRequiredArtifacts(spec: LocalLlmModelSpec): Promise<boolean> {
    const cache = await openArtifactCache();

    for (const filePath of spec.artifacts.text) {
      const url = buildLocalArtifactUrl(spec.modelId, spec.remoteRevision, filePath);
      const cached = await cache.match(url);
      if (!cached) {
        return false;
      }
    }

    return true;
  }
}

export function createLocalArtifactStore(): LocalArtifactStore {
  return new BrowserCacheArtifactStore();
}
