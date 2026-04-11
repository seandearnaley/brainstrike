import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureTransformersEnvironment } from '../gemma4-engine';
import {
  BrowserCacheArtifactStore,
  buildLocalArtifactUrl,
  resolveLocalArtifactRemoteHost,
  resolveLocalArtifactRemotePathTemplate,
} from '../local-artifact-store';
import { getLocalLlmModelSpec } from '../local-model-specs';

const originalWindow = globalThis.window;

describe('local-artifact-store', () => {
  afterEach(() => {
    if (originalWindow) {
      globalThis.window = originalWindow;
      return;
    }
    Reflect.deleteProperty(globalThis, 'window');
  });

  it('uses the app hf proxy in browser http environments', () => {
    globalThis.window = {
      location: {
        protocol: 'http:',
      },
    } as Window;

    expect(resolveLocalArtifactRemoteHost()).toBe('/api/hf/');
    expect(
      buildLocalArtifactUrl(
        'onnx-community/gemma-4-E2B-it-ONNX',
        'main',
        'onnx/decoder_model_merged_q4f16.onnx'
      )
    ).toBe(
      '/api/hf/onnx-community/gemma-4-E2B-it-ONNX/resolve/main/onnx/decoder_model_merged_q4f16.onnx'
    );
  });

  it('uses the hugging face host when window is unavailable or running from file protocol', () => {
    Reflect.deleteProperty(globalThis, 'window');
    expect(resolveLocalArtifactRemoteHost()).toBe('https://huggingface.co/');

    globalThis.window = {
      location: {
        protocol: 'file:',
      },
    } as Window;
    expect(resolveLocalArtifactRemoteHost()).toBe('https://huggingface.co/');
  });

  it('configures transformers runtime fetches to use the same remote host contract as downloads', () => {
    globalThis.window = {
      location: {
        protocol: 'http:',
      },
    } as Window;

    const environment: {
      allowRemoteModels?: boolean;
      remoteHost?: string;
      remotePathTemplate?: string;
    } = {};

    configureTransformersEnvironment(environment);

    expect(environment.allowRemoteModels).toBe(true);
    expect(environment.remoteHost).toBe('/api/hf/');
    expect(environment.remotePathTemplate).toBe(resolveLocalArtifactRemotePathTemplate());
  });

  it('rejects partial artifact responses instead of caching incomplete model files', async () => {
    globalThis.window = {
      location: {
        protocol: 'http:',
      },
    } as Window;

    const cache = {
      match: vi.fn().mockResolvedValue(undefined),
      put: vi.fn(),
    } as unknown as Cache;
    const openSpy = vi.fn().mockResolvedValue(cache);
    vi.stubGlobal('caches', {
      open: openSpy,
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('partial', {
        status: 206,
        headers: {
          'content-length': '7',
        },
      })
    );
    const spec = getLocalLlmModelSpec('onnx-community/gemma-4-E2B-it-ONNX');

    const store = new BrowserCacheArtifactStore();

    await expect(store.download(spec!)).rejects.toThrow('artifact_cache_requires_full_response');

    fetchSpy.mockRestore();
  });
});
