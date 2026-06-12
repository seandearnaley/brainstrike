import {
  getBestBuiltInLocalLlmDevice,
  isBuiltInLocalLlmDeviceAvailable,
} from '@brainstrike/assistant-contract/local-llm-device';
import { createLogger } from '@brainstrike/utils/logger';
import { Gemma4Engine } from './gemma4-engine';
import { createLocalArtifactStore } from './local-artifact-store';
import { getLocalLlmModelSpec, listLocalLlmModelSpecs } from './local-model-specs';
import type {
  LocalLlmConfig,
  LocalLlmGenerationOptions,
  LocalLlmGenerationResult,
  LocalLlmMessage,
  LocalLlmProviderStatus,
} from './types';

const logger = createLogger('LocalLlmBackend');

export function addAllowedModels(modelIds: string[]): { added: string[]; rejected: string[] } {
  const allowedIds = new Set(listLocalLlmModelSpecs().map((spec) => spec.modelId));
  return modelIds.reduce(
    (result, modelId) => {
      if (allowedIds.has(modelId)) {
        result.added.push(modelId);
      } else {
        result.rejected.push(modelId);
      }
      return result;
    },
    { added: [] as string[], rejected: [] as string[] }
  );
}

export function getAllowedModels(): string[] {
  return listLocalLlmModelSpecs().map((spec) => spec.modelId);
}

export function isModelAllowed(modelId: string): boolean {
  return Boolean(getLocalLlmModelSpec(modelId));
}

// TODO(BST-493): restore manifest-level artifact integrity verification before the next release.
export function setModelChecksums(_modelId: string, _checksums: { onnxSha256: string }): void {
  logger.warn(
    'Local checksum registration is deprecated until manifest-level integrity verification is restored (BST-493)'
  );
}

// TODO(BST-493): restore manifest-level artifact integrity verification before the next release.
export async function verifyModelIntegrity(_modelId: string, _data: ArrayBuffer): Promise<never> {
  logger.warn(
    'Built-in local artifact integrity verification is currently disabled for the Gemma manifest path (BST-493)'
  );
  throw new Error('integrity_verification_disabled');
}

function resolveRequestedDevice(requested?: 'webgpu' | 'wasm'): 'webgpu' {
  if (requested === 'wasm') {
    throw new Error('webgpu_unavailable: Gemma local inference does not support wasm');
  }
  if (!LocalLlmBackend.isDeviceAvailable('webgpu')) {
    throw new Error('webgpu_unavailable: Gemma local inference requires WebGPU');
  }
  return 'webgpu';
}

function resolveProgressPercent(progress: {
  loaded?: number;
  progress?: number;
  status?: string;
  total?: number;
}): number {
  if (typeof progress.progress === 'number') {
    return progress.progress;
  }

  if (
    typeof progress.loaded === 'number' &&
    typeof progress.total === 'number' &&
    progress.total > 0
  ) {
    return Math.round((progress.loaded / progress.total) * 100);
  }

  return progress.status === 'done' ? 100 : 0;
}

export class LocalLlmBackend {
  private engine: Gemma4Engine | null = null;
  private generationQueue: Promise<void> = Promise.resolve();
  private modelId: string | null = null;
  private selectedDevice: 'webgpu' | null = null;
  private status: LocalLlmProviderStatus = { state: 'uninitialized' };

  async initialize(config: LocalLlmConfig): Promise<void> {
    const spec = getLocalLlmModelSpec(config.modelId);
    if (!spec) {
      throw new Error(`unsupported built-in local model: ${config.modelId}`);
    }

    if (this.engine && this.modelId === config.modelId && this.selectedDevice === 'webgpu') {
      return;
    }

    await this.dispose();
    const selectedDevice = resolveRequestedDevice(config.device);
    this.status = { state: 'loading', progress: 0, message: 'Loading Gemma local model' };
    config.onProgress?.({
      stage: 'loading',
      progress: 0,
      message: 'Loading Gemma local model',
    });

    const engine = new Gemma4Engine(spec);
    await engine.initialize(selectedDevice, (progress) => {
      const percent = resolveProgressPercent(progress);
      this.status = {
        state: 'loading',
        progress: percent,
        message: `Loading ${progress.file ?? config.modelId}`,
      };
      config.onProgress?.({
        stage: 'loading',
        progress: percent,
        message: `Loading ${progress.file ?? config.modelId}`,
        ...(progress.file ? { file: progress.file } : {}),
      });
    });

    this.engine = engine;
    this.modelId = config.modelId;
    this.selectedDevice = selectedDevice;
    this.status = { state: 'ready', device: selectedDevice };
    config.onProgress?.({
      stage: 'ready',
      progress: 100,
      message: 'Model loaded',
    });
  }

  isReady(): boolean {
    return Boolean(this.engine?.isReady());
  }

  getStatus(): LocalLlmProviderStatus {
    return this.status;
  }

  async generate(
    messages: LocalLlmMessage[],
    options: LocalLlmGenerationOptions = {}
  ): Promise<LocalLlmGenerationResult> {
    if (!this.engine) {
      throw new Error('Model not initialized. Call initialize() first.');
    }

    // Serialize generations: there is ONE engine on ONE WebGPU session, and
    // overlapping model.generate calls corrupt it (interleaved KV/streamer
    // state). Callers can overlap legitimately — the Mastra loop's chat
    // generation and observational-memory observation both target this
    // backend — so the backend is the serialization chokepoint, not its
    // consumers.
    const previousTurn = this.generationQueue;
    let releaseTurn!: () => void;
    this.generationQueue = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    await previousTurn;
    try {
      if (options.signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      const engine = this.engine;
      if (!engine) {
        throw new Error('Model was disposed while waiting for the generation slot.');
      }
      const result = await engine.generate(messages, options);
      return {
        text: result.text,
        finishReason: result.toolCalls.length > 0 ? 'tool_calls' : 'stop',
        ...(result.reasoningText ? { reasoningText: result.reasoningText } : {}),
        ...(result.toolCalls.length > 0 ? { toolCalls: result.toolCalls } : {}),
        usage: result.usage,
      };
    } finally {
      releaseTurn();
    }
  }

  async dispose(): Promise<void> {
    if (this.engine) {
      await this.engine.dispose();
    }
    this.engine = null;
    this.modelId = null;
    this.selectedDevice = null;
    this.status = { state: 'uninitialized' };
  }

  static isDeviceAvailable(device: 'webgpu' | 'wasm'): boolean {
    if (device === 'wasm') {
      return typeof WebAssembly !== 'undefined';
    }
    return isBuiltInLocalLlmDeviceAvailable(device);
  }

  static getBestDevice(): 'webgpu' | null {
    return getBestBuiltInLocalLlmDevice();
  }

  static async getWebGpuInfo(): Promise<{
    vendor: string;
    architecture: string;
    device: string;
    description: string;
    maxBufferSize: number;
    maxStorageBufferBindingSize: number;
  } | null> {
    if (!(typeof navigator !== 'undefined' && 'gpu' in navigator)) {
      return null;
    }

    const gpu = (
      navigator as unknown as {
        gpu?: {
          requestAdapter: () => Promise<{
            info: {
              vendor: string;
              architecture: string;
              device: string;
              description: string;
            };
            limits: {
              maxBufferSize: number;
              maxStorageBufferBindingSize: number;
            };
          } | null>;
        };
      }
    ).gpu;
    if (!gpu) {
      return null;
    }

    const adapter = await gpu.requestAdapter();
    if (!adapter) {
      return null;
    }

    return {
      vendor: adapter.info.vendor,
      architecture: adapter.info.architecture,
      device: adapter.info.device,
      description: adapter.info.description,
      maxBufferSize: adapter.limits.maxBufferSize,
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
    };
  }

  static async downloadModel(
    modelId: string,
    options?: {
      cacheDir?: string;
      onProgress?: (progress: {
        stage: 'downloading' | 'ready';
        progress: number;
        message: string;
        file?: string;
      }) => void;
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
    await store.download(
      spec,
      options?.onProgress as LocalLlmConfig['onProgress'],
      options?.signal
    );
  }

  static async hasDownloadedModel(modelId: string): Promise<boolean> {
    const spec = getLocalLlmModelSpec(modelId);
    if (!spec) {
      return false;
    }
    const store = createLocalArtifactStore();
    return await store.hasRequiredArtifacts(spec);
  }
}
