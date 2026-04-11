import { createLogger } from '@brainstrike/utils/logger';
import type { LocalLlmModelSpec } from './local-model-specs';
import type { LocalLlmProgressCallback } from './types';

const logger = createLogger('LocalArtifactStore');
const TRANSFORMERS_CACHE_NAME = 'transformers-cache';
const QUOTA_SAFETY_BUFFER = 1.1;
const HUGGING_FACE_REMOTE_HOST = 'https://huggingface.co/';
const HUGGING_FACE_REMOTE_PATH_TEMPLATE = '{model}/resolve/{revision}/';

export interface LocalArtifactStore {
  download(
    spec: LocalLlmModelSpec,
    onProgress?: LocalLlmProgressCallback,
    signal?: AbortSignal
  ): Promise<void>;
  hasRequiredArtifacts(spec: LocalLlmModelSpec): Promise<boolean>;
}

interface ArtifactStatus {
  cachedBytes: number | null;
  filePath: string;
  isCached: boolean;
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

async function readCachedArtifactBytes(response: Response): Promise<number | null> {
  const contentLength = response.headers.get('content-length');
  const parsedLength = contentLength ? Number.parseInt(contentLength, 10) : Number.NaN;
  if (Number.isFinite(parsedLength) && parsedLength > 0) {
    return parsedLength;
  }

  return null;
}

async function describeArtifacts(cache: Cache, spec: LocalLlmModelSpec): Promise<ArtifactStatus[]> {
  const statuses: ArtifactStatus[] = [];

  for (const filePath of getArtifactPaths(spec)) {
    const url = buildLocalArtifactUrl(spec.modelId, spec.remoteRevision, filePath);
    const cached = await cache.match(url);
    if (cached?.status === 200) {
      statuses.push({
        filePath,
        isCached: true,
        cachedBytes: await readCachedArtifactBytes(cached),
      });
      continue;
    }

    statuses.push({
      filePath,
      isCached: false,
      cachedBytes: null,
    });
  }

  return statuses;
}

async function estimateRemainingArtifactBytes(
  cache: Cache,
  spec: LocalLlmModelSpec
): Promise<{ files: ArtifactStatus[]; requiredBytes: number }> {
  const files = await describeArtifacts(cache, spec);
  const cachedBytes = files.reduce((sum, file) => sum + (file.cachedBytes ?? 0), 0);
  const missingFileCount = files.filter((file) => !file.isCached).length;

  return {
    files,
    requiredBytes: missingFileCount === 0 ? 0 : Math.max(0, spec.totalSizeBytes - cachedBytes),
  };
}

function toProgressPercent(completedBytes: number, totalBytes: number): number {
  if (totalBytes <= 0) {
    return 0;
  }
  return Math.round((Math.min(completedBytes, totalBytes) / totalBytes) * 100);
}

async function cacheResponseStream(
  cache: Cache,
  url: string,
  response: Response,
  onChunkProgress: (loaded: number, total: number | null) => void
): Promise<number> {
  if (response.status !== 200) {
    throw new Error(`artifact_cache_requires_full_response: ${url} returned ${response.status}`);
  }
  if (!response.body) {
    await cache.put(url, response.clone());
    onChunkProgress(1, 1);
    return 1;
  }

  const totalHeader = response.headers.get('content-length');
  const total = totalHeader ? Number.parseInt(totalHeader, 10) : null;
  let loaded = 0;
  const progressStream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      loaded += chunk.byteLength;
      onChunkProgress(loaded, Number.isFinite(total) ? total : null);
      controller.enqueue(chunk);
    },
  });

  await cache.put(
    url,
    new Response(response.body.pipeThrough(progressStream), {
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
  return loaded;
}

export class BrowserCacheArtifactStore implements LocalArtifactStore {
  async download(
    spec: LocalLlmModelSpec,
    onProgress?: LocalLlmProgressCallback,
    signal?: AbortSignal
  ): Promise<void> {
    const cache = await openArtifactCache();
    const { files, requiredBytes } = await estimateRemainingArtifactBytes(cache, spec);
    await checkStorageQuota(requiredBytes);
    let downloadedBytes = files.reduce((sum, file) => sum + (file.cachedBytes ?? 0), 0);

    for (const file of files) {
      const filePath = file.filePath;
      const url = buildLocalArtifactUrl(spec.modelId, spec.remoteRevision, filePath);
      if (file.isCached) {
        continue;
      }

      const response = await fetch(url, {
        headers: {
          accept: '*/*',
        },
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) {
        throw new Error(`artifact_download_failed: ${filePath} returned ${response.status}`);
      }

      const downloadedFileBytes = await cacheResponseStream(
        cache,
        url,
        response,
        (loaded, total) => {
          onProgress?.({
            stage: 'downloading',
            progress: toProgressPercent(
              downloadedBytes + loaded,
              Math.max(spec.totalSizeBytes, downloadedBytes + (total ?? loaded))
            ),
            message: `Downloading ${filePath}`,
            file: filePath,
          });
        }
      );

      downloadedBytes += downloadedFileBytes;
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
