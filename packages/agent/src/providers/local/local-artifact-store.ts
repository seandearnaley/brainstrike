import { createLogger } from '@brainstrike/utils/logger';
import type { LocalLlmModelSpec } from './local-model-specs';
import type { LocalLlmProgressCallback } from './types';

const logger = createLogger('LocalArtifactStore');
const TRANSFORMERS_CACHE_NAME = 'transformers-cache';
const QUOTA_SAFETY_BUFFER = 1.1;
const HUGGING_FACE_REMOTE_HOST = 'https://huggingface.co/';
const HUGGING_FACE_REMOTE_PATH_TEMPLATE = '{model}/resolve/{revision}/';

export interface LocalArtifactStore {
  download(spec: LocalLlmModelSpec, onProgress?: LocalLlmProgressCallback): Promise<void>;
  hasRequiredArtifacts(spec: LocalLlmModelSpec): Promise<boolean>;
}

export function resolveLocalArtifactRemoteHost(): string {
  if (typeof window === 'undefined') {
    return HUGGING_FACE_REMOTE_HOST;
  }

  if (window.location.protocol === 'file:') {
    return HUGGING_FACE_REMOTE_HOST;
  }

  return '/api/hf/';
}

export function resolveLocalArtifactRemotePathTemplate(): string {
  return HUGGING_FACE_REMOTE_PATH_TEMPLATE;
}

export function buildLocalArtifactUrl(
  modelId: string,
  revision: string,
  relativePath: string
): string {
  const base = resolveLocalArtifactRemoteHost().replace(/\/+$/, '');
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

function getArtifactPaths(spec: LocalLlmModelSpec): string[] {
  return [
    ...spec.artifacts.text,
    ...(spec.artifacts.vision ?? []),
    ...(spec.artifacts.audio ?? []),
  ];
}

async function estimateRemainingArtifactBytes(
  cache: Cache,
  spec: LocalLlmModelSpec
): Promise<{ files: string[]; requiredBytes: number }> {
  const files = getArtifactPaths(spec);
  let cachedBytes = 0;
  const missingFiles: string[] = [];

  for (const filePath of files) {
    const url = buildLocalArtifactUrl(spec.modelId, spec.remoteRevision, filePath);
    const cached = await cache.match(url);
    if (cached?.status === 200) {
      const contentLength = cached.headers.get('content-length');
      const parsedLength = contentLength ? Number.parseInt(contentLength, 10) : Number.NaN;
      if (Number.isFinite(parsedLength) && parsedLength > 0) {
        cachedBytes += parsedLength;
      }
      continue;
    }
    missingFiles.push(filePath);
  }

  return {
    files,
    requiredBytes: Math.max(0, spec.totalSizeBytes - cachedBytes),
  };
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
  if (response.status !== 200) {
    throw new Error(`artifact_cache_requires_full_response: ${url} returned ${response.status}`);
  }
  if (!response.body) {
    await cache.put(url, response.clone());
    onChunkProgress(1, 1);
    return;
  }

  const [cacheStream, progressStream] = response.body.tee();
  const cachePut = cache.put(
    url,
    new Response(cacheStream, {
      headers: new Headers(
        Object.fromEntries(
          ['cache-control', 'content-length', 'content-type']
            .map((header) => [header, response.headers.get(header)])
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        )
      ),
      status: 200,
      statusText: 'OK',
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
    const cache = await openArtifactCache();
    const { files, requiredBytes } = await estimateRemainingArtifactBytes(cache, spec);
    await checkStorageQuota(requiredBytes);
    let completed = 0;

    for (const filePath of files) {
      const url = buildLocalArtifactUrl(spec.modelId, spec.remoteRevision, filePath);
      const cached = await cache.match(url);
      if (cached?.status === 200) {
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

    for (const filePath of getArtifactPaths(spec)) {
      const url = buildLocalArtifactUrl(spec.modelId, spec.remoteRevision, filePath);
      const cached = await cache.match(url);
      if (cached?.status !== 200) {
        return false;
      }
    }

    return true;
  }
}

export function createLocalArtifactStore(): LocalArtifactStore {
  return new BrowserCacheArtifactStore();
}
