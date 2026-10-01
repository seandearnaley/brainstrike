import type { PretrainedModelOptions, ProgressInfo } from '@huggingface/transformers';

export interface ModelDownloadRequest {
  readonly cacheDir?: string;
  readonly id: string;
  readonly model: string;
}

export function assertModelDownloadRequest(value: unknown): ModelDownloadRequest {
  if (!(value && typeof value === 'object' && !Array.isArray(value))) {
    throw new Error('Embedding download request must be an object.');
  }
  const request = value as Record<string, unknown>;
  for (const key of ['id', 'model', 'cacheDir'] as const) {
    if (key === 'cacheDir' && request[key] === undefined) {
      continue;
    }
    if (!(typeof request[key] === 'string' && request[key].trim().length > 0)) {
      throw new Error(`Embedding download ${key} must be a non-empty string.`);
    }
  }
  return value as ModelDownloadRequest;
}

export type ModelDownloadEvent =
  | { readonly id: string; readonly type: 'download-progress'; readonly progress: number }
  | { readonly id: string; readonly type: 'download-complete' }
  | { readonly id: string; readonly type: 'download-error'; readonly message: string };

export function readModelDownloadEvent(value: unknown, id: string): ModelDownloadEvent | null {
  if (!(value && typeof value === 'object')) {
    return null;
  }
  const event = value as Record<string, unknown>;
  if (event['id'] !== id) {
    return null;
  }
  if (event['type'] === 'download-complete') {
    return { id, type: 'download-complete' };
  }
  if (event['type'] === 'download-error' && typeof event['message'] === 'string') {
    return { id, message: event['message'], type: 'download-error' };
  }
  const progress = event['progress'];
  if (
    event['type'] === 'download-progress' &&
    typeof progress === 'number' &&
    Number.isFinite(progress) &&
    progress >= 0 &&
    progress < 100
  ) {
    return { id, progress, type: 'download-progress' };
  }
  throw new Error('Invalid embedding download response.');
}

export type DownloadPipelineFactory = (
  task: 'feature-extraction',
  model: string,
  options: PretrainedModelOptions
) => Promise<{ dispose: () => Promise<unknown> }>;

/** A download creates a session through the public API and releases it before success. */
export async function downloadEmbeddingModelArtifacts(
  request: ModelDownloadRequest,
  pipeline: DownloadPipelineFactory,
  onProgress: (progress: number) => void
): Promise<void> {
  assertModelDownloadRequest(request);
  const options: PretrainedModelOptions = {};
  if (request.cacheDir) {
    options.cache_dir = request.cacheDir;
  }
  options.progress_callback = (progress: ProgressInfo): void => {
    if (progress.status === 'progress' && progress.total > 0) {
      // File completion does not prove that session creation and disposal succeeded.
      onProgress(Math.min(99, Math.round((progress.loaded / progress.total) * 100)));
    }
  };
  const resource = await pipeline('feature-extraction', request.model, options);
  await resource.dispose();
}
