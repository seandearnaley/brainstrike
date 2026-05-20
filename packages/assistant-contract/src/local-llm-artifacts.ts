import { createLogger } from '@brainstrike/utils/logger';
import type { LocalLlmProgressCallback } from './local-llm.js';
import { getLocalLlmModelSpec, type LocalLlmModelSpec } from './local-llm-model-specs.js';

const logger = createLogger('LocalArtifactStore');
const TRANSFORMERS_CACHE_NAME = 'transformers-cache';
const QUOTA_SAFETY_BUFFER = 1.1;
const HUGGING_FACE_REMOTE_HOST = 'https://huggingface.co/';
const HUGGING_FACE_REMOTE_PATH_TEMPLATE = '{model}/resolve/{revision}/';
const LOCAL_ARTIFACT_REMOTE_HOST_OVERRIDE_KEY = '__BRAINSTRIKE_LOCAL_ARTIFACT_REMOTE_HOST__';

export interface LocalArtifactStore {
  download(
    spec: LocalLlmModelSpec,
    onProgress?: LocalLlmProgressCallback,
    signal?: AbortSignal
  ): Promise<void>;
  hasRequiredArtifacts(spec: LocalLlmModelSpec): Promise<boolean>;
}

interface ArtifactStatus {
  cachedBytes: number;
  filePath: string;
  isCached: boolean;
}

function readRemoteHostOverride(): string | null {
  const override = (
    globalThis as typeof globalThis & {
      [LOCAL_ARTIFACT_REMOTE_HOST_OVERRIDE_KEY]?: unknown;
    }
  )[LOCAL_ARTIFACT_REMOTE_HOST_OVERRIDE_KEY];
  return typeof override === 'string' && override.trim().length > 0 ? override.trim() : null;
}

function isElectronRendererWindow(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  const maybeWindow = window as Window & {
    electronAPI?: unknown;
    process?: { type?: unknown };
  };

  return maybeWindow.process?.type === 'renderer' || typeof maybeWindow.electronAPI !== 'undefined';
}

export function resolveLocalArtifactRemoteHost(): string {
  const override = readRemoteHostOverride();
  if (override) {
    return override;
  }

  if (typeof window === 'undefined') {
    return HUGGING_FACE_REMOTE_HOST;
  }

  switch (window.location.protocol) {
    case 'http:':
    case 'https:':
      return isElectronRendererWindow()
        ? HUGGING_FACE_REMOTE_HOST
        : `${window.location.origin}/api/hf/`;
    default:
      return HUGGING_FACE_REMOTE_HOST;
  }
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
  if (typeof estimate.quota !== 'number') {
    // Some browsers do not expose quota at all. Skip enforcement rather than falsely rejecting a
    // download we cannot size against. If quota is known but usage is missing, assume the bucket is
    // already full so the check stays conservative instead of silently bypassing enforcement.
    return;
  }

  const usage = typeof estimate.usage === 'number' ? estimate.usage : estimate.quota;
  const available = estimate.quota - usage;
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

async function readCachedArtifactBytes(response: Response): Promise<number> {
  const contentLength = response.headers.get('content-length');
  const parsedLength = contentLength ? Number.parseInt(contentLength, 10) : Number.NaN;
  if (Number.isFinite(parsedLength) && parsedLength > 0) {
    return parsedLength;
  }

  return 0;
}

async function describeArtifacts(cache: Cache, spec: LocalLlmModelSpec): Promise<ArtifactStatus[]> {
  const statuses: ArtifactStatus[] = [];

  for (const filePath of getArtifactPaths(spec)) {
    const url = buildLocalArtifactUrl(spec.modelId, spec.remoteRevision, filePath);
    const cached = await cache.match(url);
    if (cached?.status === 200) {
      const cachedBytes = await readCachedArtifactBytes(cached);
      statuses.push({
        filePath,
        isCached: true,
        cachedBytes,
      });
      continue;
    }

    statuses.push({
      filePath,
      isCached: false,
      cachedBytes: 0,
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
    const totalHeader = response.headers.get('content-length');
    const parsedLength = totalHeader ? Number.parseInt(totalHeader, 10) : 0;
    const loaded = Number.isFinite(parsedLength) && parsedLength >= 0 ? parsedLength : 0;
    onChunkProgress(loaded, loaded > 0 ? loaded : null);
    return loaded;
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
    const totalExpectedBytes = downloadedBytes + requiredBytes;

    for (const file of files) {
      signal?.throwIfAborted();
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
              Math.max(totalExpectedBytes, downloadedBytes + (total ?? loaded))
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

export async function downloadBuiltInLocalLlmModel(
  modelId: string,
  options?: {
    cacheDir?: string;
    onProgress?: LocalLlmProgressCallback;
    signal?: AbortSignal;
  }
): Promise<void> {
  const spec = getLocalLlmModelSpec(modelId);
  if (!spec) {
    throw new Error(`unsupported built-in local model: ${modelId}`);
  }

  if (options?.cacheDir) {
    logger.info('Ignoring browser cacheDir hint for local browser model download', {
      modelId,
      cacheDir: options.cacheDir,
    });
  }

  const store = createLocalArtifactStore();
  await store.download(spec, options?.onProgress, options?.signal);
}

export async function hasDownloadedBuiltInLocalLlmModel(modelId: string): Promise<boolean> {
  const spec = getLocalLlmModelSpec(modelId);
  if (!spec) {
    return false;
  }
  const store = createLocalArtifactStore();
  return await store.hasRequiredArtifacts(spec);
}
