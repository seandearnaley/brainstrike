// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetDesktopLlmHostStateForTests,
  handleDesktopLoadingProgressEvent,
  warmDesktopLocalModel,
} from '../local-runtime-desktop-host';

type ProgressListener = (progress: unknown) => void;

function installHost(overrides: Record<string, unknown> = {}): {
  emit: (progress: unknown) => void;
  host: Record<string, unknown>;
  unsubscribe: ReturnType<typeof vi.fn>;
} {
  let listener: ProgressListener | null = null;
  const unsubscribe = vi.fn();
  const host: Record<string, unknown> = {
    onProgress: (next: ProgressListener) => {
      listener = next;
      return unsubscribe;
    },
    warmup: vi.fn(async () => undefined),
    ...overrides,
  };
  (window as Window & { llmHost?: unknown }).llmHost = host;
  return {
    emit: (progress: unknown) => listener?.(progress),
    host,
    unsubscribe,
  };
}

describe('desktop llm-host bridge', () => {
  beforeEach(() => {
    __resetDesktopLlmHostStateForTests();
  });

  afterEach(() => {
    __resetDesktopLlmHostStateForTests();
    (window as Window & { llmHost?: unknown }).llmHost = undefined;
    vi.unstubAllGlobals();
  });

  // No silent degradation: a host without the bridge cannot do local
  // inference, and the caller must see that instead of a quiet no-op.
  it('refuses to warm a model when no bridge exists', async () => {
    (window as Window & { llmHost?: unknown }).llmHost = undefined;

    await expect(warmDesktopLocalModel({ modelId: 'gemma' })).rejects.toThrow(
      'Desktop llm host bridge is unavailable'
    );
  });

  it('refuses when the bridge exists but implements no warmup', async () => {
    installHost({ warmup: undefined });

    await expect(warmDesktopLocalModel({ modelId: 'gemma' })).rejects.toThrow(
      'does not implement warmup'
    );
  });

  it('warms a model once and reuses the result for later callers', async () => {
    const { host } = installHost();

    await warmDesktopLocalModel({ modelId: 'gemma' });
    await warmDesktopLocalModel({ modelId: 'gemma' });

    expect(host['warmup']).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight warmup between concurrent callers', async () => {
    let releaseWarmup: (() => void) | undefined;
    const warmup = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseWarmup = resolve;
        })
    );
    installHost({ warmup });

    const first = warmDesktopLocalModel({ modelId: 'gemma' });
    const second = warmDesktopLocalModel({ modelId: 'gemma' });
    releaseWarmup?.();
    await Promise.all([first, second]);

    expect(warmup).toHaveBeenCalledTimes(1);
  });

  it('forgets the warm model when the host reports it stopped', async () => {
    let statusListener: ((status: { runtimeKind: 'llm-host'; state: string }) => void) | undefined;
    const { host } = installHost({
      onStatus: (listener: (status: { runtimeKind: 'llm-host'; state: string }) => void) => {
        statusListener = listener;
        return vi.fn();
      },
    });

    await warmDesktopLocalModel({ modelId: 'gemma' });
    statusListener?.({ runtimeKind: 'llm-host', state: 'stopped' });
    await warmDesktopLocalModel({ modelId: 'gemma' });

    expect(host['warmup']).toHaveBeenCalledTimes(2);
  });

  it('reports download progress for the warming request and unsubscribes after', async () => {
    const onLoadingProgress = vi.fn();
    let capturedRequestId: string | undefined;
    let releaseWarmup: (() => void) | undefined;
    const { emit, unsubscribe } = installHost({
      warmup: vi.fn((payload: { modelId: string; requestId?: string }) => {
        capturedRequestId = payload.requestId;
        return new Promise<void>((resolve) => {
          releaseWarmup = resolve;
        });
      }),
    });

    const warming = warmDesktopLocalModel({ modelId: 'gemma', onLoadingProgress });
    await Promise.resolve();

    emit({
      payload: {
        clientRequestId: capturedRequestId,
        file: 'model.onnx',
        kind: 'loading',
        message: 'Downloading model.onnx',
        progress: 42,
      },
      requestId: 'host-1',
      type: 'progress',
    });

    expect(onLoadingProgress).toHaveBeenCalledWith({
      file: 'model.onnx',
      message: 'Downloading model.onnx',
      progress: 42,
      stage: 'loading',
    });

    releaseWarmup?.();
    await warming;
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('aborts a warmup wait without cancelling the shared warmup', async () => {
    const controller = new AbortController();
    installHost({ warmup: vi.fn(() => new Promise<void>(() => undefined)) });

    const warming = warmDesktopLocalModel({ modelId: 'gemma', signal: controller.signal });
    controller.abort();

    await expect(warming).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { host } = installHost({ warmup: vi.fn(() => new Promise<void>(() => undefined)) });

    const first = warmDesktopLocalModel({ modelId: 'gemma' });
    void first.catch(() => undefined);
    await Promise.resolve();

    await expect(
      warmDesktopLocalModel({ modelId: 'gemma', signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(host['warmup']).toHaveBeenCalledTimes(1);
  });
});

describe('handleDesktopLoadingProgressEvent', () => {
  it('ignores reports belonging to another request', () => {
    const onLoadingProgress = vi.fn();

    handleDesktopLoadingProgressEvent(
      {
        payload: { clientRequestId: 'other-request', kind: 'loading', progress: 10 },
        requestId: 'host-request',
        type: 'progress',
      },
      'request-1',
      onLoadingProgress
    );

    expect(onLoadingProgress).not.toHaveBeenCalled();
  });

  // Generation-kind reports only ever reach the generate path; a warmup that
  // somehow saw one must not relabel the badge.
  it('ignores non-loading report kinds', () => {
    const onLoadingProgress = vi.fn();

    handleDesktopLoadingProgressEvent(
      {
        payload: { clientRequestId: 'request-1', kind: 'text', text: 'partial' },
        requestId: 'host-request',
        type: 'progress',
      },
      'request-1',
      onLoadingProgress
    );

    expect(onLoadingProgress).not.toHaveBeenCalled();
  });

  it('ignores values that are not progress events', () => {
    const onLoadingProgress = vi.fn();

    handleDesktopLoadingProgressEvent(null, 'request-1', onLoadingProgress);
    handleDesktopLoadingProgressEvent({ type: 'status' }, 'request-1', onLoadingProgress);

    expect(onLoadingProgress).not.toHaveBeenCalled();
  });

  it('defaults a loading report with no message or progress', () => {
    const onLoadingProgress = vi.fn();

    handleDesktopLoadingProgressEvent(
      {
        payload: { clientRequestId: 'request-1', kind: 'loading' },
        requestId: 'host-request',
        type: 'progress',
      },
      'request-1',
      onLoadingProgress
    );

    expect(onLoadingProgress).toHaveBeenCalledWith({
      message: 'Loading Gemma local model',
      progress: 0,
      stage: 'loading',
    });
  });
});
