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
    Reflect.deleteProperty(globalThis, '__BRAINSTRIKE_LOCAL_ARTIFACT_REMOTE_HOST__');
    if (originalWindow) {
      globalThis.window = originalWindow;
      return;
    }
    Reflect.deleteProperty(globalThis, 'window');
  });

  it('uses the app hf proxy with full origin in browser http environments', () => {
    globalThis.window = {
      location: {
        origin: 'http://localhost:8080',
        protocol: 'http:',
      },
    } as Window;

    expect(resolveLocalArtifactRemoteHost()).toBe('http://localhost:8080/api/hf/');
    expect(
      buildLocalArtifactUrl(
        'onnx-community/gemma-4-E2B-it-ONNX',
        'main',
        'onnx/decoder_model_merged_q4f16.onnx'
      )
    ).toBe(
      'http://localhost:8080/api/hf/onnx-community/gemma-4-E2B-it-ONNX/resolve/main/onnx/decoder_model_merged_q4f16.onnx'
    );
  });

  it('uses the hugging face host for electron renderers even when they are served over http', () => {
    globalThis.window = {
      electronAPI: {},
      location: {
        protocol: 'http:',
      },
    } as Window & { electronAPI: Record<string, never> };

    expect(resolveLocalArtifactRemoteHost()).toBe('https://huggingface.co/');
    expect(buildLocalArtifactUrl('onnx-community/gemma-4-E2B-it-ONNX', 'main', 'config.json')).toBe(
      'https://huggingface.co/onnx-community/gemma-4-E2B-it-ONNX/resolve/main/config.json'
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

  it('uses the hugging face host for non-http desktop protocols', () => {
    globalThis.window = {
      location: {
        protocol: 'app:',
      },
    } as Window;

    expect(resolveLocalArtifactRemoteHost()).toBe('https://huggingface.co/');
  });

  it('prefers an explicit remote host override when provided', () => {
    (
      globalThis as typeof globalThis & {
        __BRAINSTRIKE_LOCAL_ARTIFACT_REMOTE_HOST__?: string;
      }
    ).__BRAINSTRIKE_LOCAL_ARTIFACT_REMOTE_HOST__ = 'https://cache.internal/hf/';

    expect(resolveLocalArtifactRemoteHost()).toBe('https://cache.internal/hf/');

    Reflect.deleteProperty(globalThis, '__BRAINSTRIKE_LOCAL_ARTIFACT_REMOTE_HOST__');
  });

  it('configures transformers runtime fetches to use the same remote host contract as downloads', () => {
    globalThis.window = {
      location: {
        origin: 'http://localhost:8080',
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
    expect(environment.remoteHost).toBe('http://localhost:8080/api/hf/');
    expect(environment.remotePathTemplate).toBe(resolveLocalArtifactRemotePathTemplate());
  });

  it('configures transformers runtime fetches to use hugging face directly in electron renderers', () => {
    globalThis.window = {
      electronAPI: {},
      location: {
        protocol: 'http:',
      },
    } as Window & { electronAPI: Record<string, never> };

    const environment: {
      allowRemoteModels?: boolean;
      remoteHost?: string;
      remotePathTemplate?: string;
    } = {};

    configureTransformersEnvironment(environment);

    expect(environment.allowRemoteModels).toBe(true);
    expect(environment.remoteHost).toBe('https://huggingface.co/');
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
        headers: {
          'content-length': '7',
        },
        status: 206,
      })
    );
    const spec = getLocalLlmModelSpec('onnx-community/gemma-4-E2B-it-ONNX');

    const store = new BrowserCacheArtifactStore();

    await expect(store.download(spec!)).rejects.toThrow('artifact_cache_requires_full_response');

    fetchSpy.mockRestore();
  });

  it('checks storage quota against only the missing artifact bytes', async () => {
    globalThis.window = {
      location: {
        protocol: 'http:',
      },
    } as Window;

    const cache = {
      match: vi.fn().mockImplementation(async (url: string) => {
        if (url.endsWith('/config.json')) {
          return new Response('cached', {
            headers: {
              'content-length': String(3900 * 1024 * 1024),
            },
            status: 200,
          });
        }
      }),
      put: vi.fn(),
    } as unknown as Cache;
    vi.stubGlobal('caches', {
      open: vi.fn().mockResolvedValue(cache),
    });
    vi.stubGlobal('navigator', {
      storage: {
        estimate: vi.fn().mockResolvedValue({
          quota: 5000 * 1024 * 1024,
          usage: 4000 * 1024 * 1024,
        }),
      },
    });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async () => new Response('ok', { headers: { 'content-length': '2' }, status: 200 })
      );
    const spec = getLocalLlmModelSpec('onnx-community/gemma-4-E2B-it-ONNX');

    await expect(new BrowserCacheArtifactStore().download(spec!)).resolves.toBeUndefined();

    expect(fetchSpy).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('weights download progress by bytes instead of equal file counts', async () => {
    globalThis.window = {
      location: {
        protocol: 'http:',
      },
    } as Window;

    const cache = {
      match: vi.fn().mockImplementation(async (url: string) => {
        if (url.endsWith('/large.onnx')) {
          return new Response('cached-large', {
            headers: {
              'content-length': '900',
            },
            status: 200,
          });
        }
      }),
      put: vi.fn(async (_url: string, response: Response) => {
        await response.arrayBuffer();
      }),
    } as unknown as Cache;
    vi.stubGlobal('caches', {
      open: vi.fn().mockResolvedValue(cache),
    });
    vi.stubGlobal('navigator', {
      storage: {
        estimate: vi.fn().mockResolvedValue({
          quota: 5000,
          usage: 900,
        }),
      },
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(50));
            controller.enqueue(new Uint8Array(50));
            controller.close();
          },
        }),
        {
          headers: {
            'content-length': '100',
          },
          status: 200,
        }
      )
    );

    const spec = {
      ...getLocalLlmModelSpec('onnx-community/gemma-4-E2B-it-ONNX')!,
      artifacts: {
        text: ['large.onnx', 'small.onnx'],
      },
      totalSizeBytes: 1000,
    };
    const progress = vi.fn();

    await new BrowserCacheArtifactStore().download(spec, progress);

    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({
        file: 'small.onnx',
        progress: 95,
        stage: 'downloading',
      })
    );
    fetchSpy.mockRestore();
  });

  it('forwards abort signals to artifact fetches', async () => {
    globalThis.window = {
      location: {
        protocol: 'http:',
      },
    } as Window;

    const cache = {
      match: vi.fn().mockResolvedValue(undefined),
      put: vi.fn(async (_url: string, response: Response) => {
        await response.arrayBuffer();
      }),
    } as unknown as Cache;
    vi.stubGlobal('caches', {
      open: vi.fn().mockResolvedValue(cache),
    });
    vi.stubGlobal('navigator', {
      storage: {
        estimate: vi.fn().mockResolvedValue({
          quota: 5000 * 1024 * 1024,
          usage: 0,
        }),
      },
    });

    const controller = new AbortController();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        new ReadableStream({
          start(streamController) {
            streamController.enqueue(new Uint8Array([1]));
            streamController.close();
          },
        }),
        {
          headers: {
            'content-length': '1',
          },
          status: 200,
        }
      )
    );

    const spec = {
      ...getLocalLlmModelSpec('onnx-community/gemma-4-E2B-it-ONNX')!,
      artifacts: {
        text: ['config.json'],
      },
      totalSizeBytes: 1,
    };

    await new BrowserCacheArtifactStore().download(spec, undefined, controller.signal);

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        signal: controller.signal,
      })
    );
    fetchSpy.mockRestore();
  });

  it('stops before fetching the next artifact when aborted between files', async () => {
    globalThis.window = {
      location: {
        protocol: 'http:',
      },
    } as Window;

    const cache = {
      match: vi.fn().mockResolvedValue(undefined),
      put: vi.fn(async (_url: string, response: Response) => {
        await response.arrayBuffer();
      }),
    } as unknown as Cache;
    vi.stubGlobal('caches', {
      open: vi.fn().mockResolvedValue(cache),
    });
    vi.stubGlobal('navigator', {
      storage: {
        estimate: vi.fn().mockResolvedValue({
          quota: 5000,
          usage: 0,
        }),
      },
    });

    const controller = new AbortController();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response('first', { headers: { 'content-length': '5' }, status: 200 })
      )
      .mockImplementationOnce(async () => {
        throw new Error('second fetch should not run');
      });

    const spec = {
      ...getLocalLlmModelSpec('onnx-community/gemma-4-E2B-it-ONNX')!,
      artifacts: {
        text: ['config.json', 'tokenizer.json'],
      },
      totalSizeBytes: 10,
    };

    cache.put = vi.fn(async (_url: string, response: Response) => {
      await response.arrayBuffer();
      controller.abort();
    });

    await expect(
      new BrowserCacheArtifactStore().download(spec, undefined, controller.signal)
    ).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });

  it('treats cached artifacts without content-length as cached without rereading them', async () => {
    globalThis.window = {
      location: {
        protocol: 'http:',
      },
    } as Window;

    const blobSpy = vi.fn(async () => new Blob(['cached']));
    const cache = {
      match: vi.fn().mockResolvedValue({
        clone: () => ({
          blob: blobSpy,
        }),
        headers: new Headers(),
        status: 200,
      } as unknown as Response),
      put: vi.fn(),
    } as unknown as Cache;
    vi.stubGlobal('caches', {
      open: vi.fn().mockResolvedValue(cache),
    });
    vi.stubGlobal('navigator', {
      storage: {
        estimate: vi.fn().mockResolvedValue({
          quota: 5000 * 1024 * 1024,
          usage: 100,
        }),
      },
    });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async () => new Response('ok', { headers: { 'content-length': '2' }, status: 200 })
      );
    const spec = getLocalLlmModelSpec('onnx-community/gemma-4-E2B-it-ONNX');

    await expect(new BrowserCacheArtifactStore().download(spec!)).resolves.toBeUndefined();

    expect(blobSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('skips quota enforcement only when the browser does not expose quota at all', async () => {
    globalThis.window = {
      location: {
        protocol: 'http:',
      },
    } as Window;

    const cache = {
      match: vi.fn().mockResolvedValue(undefined),
      put: vi.fn(async (_url: string, response: Response) => {
        await response.arrayBuffer();
      }),
    } as unknown as Cache;
    vi.stubGlobal('caches', {
      open: vi.fn().mockResolvedValue(cache),
    });
    vi.stubGlobal('navigator', {
      storage: {
        estimate: vi.fn().mockResolvedValue({}),
      },
    });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok', { headers: { 'content-length': '2' }, status: 200 }));

    await expect(
      new BrowserCacheArtifactStore().download({
        ...getLocalLlmModelSpec('onnx-community/gemma-4-E2B-it-ONNX')!,
        artifacts: {
          text: ['config.json'],
        },
        totalSizeBytes: 2,
      })
    ).resolves.toBeUndefined();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });

  it('treats missing usage as a full bucket when quota is known', async () => {
    globalThis.window = {
      location: {
        protocol: 'http:',
      },
    } as Window;

    const cache = {
      match: vi.fn().mockResolvedValue(undefined),
      put: vi.fn(async (_url: string, response: Response) => {
        await response.arrayBuffer();
      }),
    } as unknown as Cache;
    vi.stubGlobal('caches', {
      open: vi.fn().mockResolvedValue(cache),
    });
    vi.stubGlobal('navigator', {
      storage: {
        estimate: vi.fn().mockResolvedValue({
          quota: 10,
        }),
      },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(
      new BrowserCacheArtifactStore().download({
        ...getLocalLlmModelSpec('onnx-community/gemma-4-E2B-it-ONNX')!,
        artifacts: {
          text: ['config.json'],
        },
        totalSizeBytes: 20,
      })
    ).rejects.toThrow('storage_insufficient');

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('normalizes malformed or negative content-length values for body-less responses', async () => {
    globalThis.window = {
      location: {
        protocol: 'http:',
      },
    } as Window;

    const cache = {
      match: vi.fn().mockResolvedValue(undefined),
      put: vi.fn(async (_url: string, response: Response) => {
        await response.arrayBuffer();
      }),
    } as unknown as Cache;
    vi.stubGlobal('caches', {
      open: vi.fn().mockResolvedValue(cache),
    });
    vi.stubGlobal('navigator', {
      storage: {
        estimate: vi.fn().mockResolvedValue({
          quota: 5000,
          usage: 0,
        }),
      },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, {
        headers: { 'content-length': '-5' },
        status: 200,
      })
    );
    const progress = vi.fn();

    await expect(
      new BrowserCacheArtifactStore().download(
        {
          ...getLocalLlmModelSpec('onnx-community/gemma-4-E2B-it-ONNX')!,
          artifacts: {
            text: ['config.json'],
          },
          totalSizeBytes: 1,
        },
        progress
      )
    ).resolves.toBeUndefined();

    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({
        progress: 0,
        stage: 'downloading',
      })
    );
    fetchSpy.mockRestore();
  });

  it('treats multimodal artifacts as required when checking download completeness', async () => {
    globalThis.window = {
      location: {
        protocol: 'http:',
      },
    } as Window;

    const cache = {
      match: vi
        .fn()
        .mockImplementation(async (url: string) =>
          url.includes('vision_encoder') ? undefined : new Response('ok', { status: 200 })
        ),
      put: vi.fn(),
    } as unknown as Cache;
    vi.stubGlobal('caches', {
      open: vi.fn().mockResolvedValue(cache),
    });

    const store = new BrowserCacheArtifactStore();
    const spec = {
      ...getLocalLlmModelSpec('onnx-community/gemma-4-E2B-it-ONNX')!,
      artifacts: {
        text: ['config.json'],
        vision: ['onnx/vision_encoder_q4f16.onnx'],
      },
    };

    await expect(store.hasRequiredArtifacts(spec)).resolves.toBe(false);
  });
});
