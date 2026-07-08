import type { LocalLlmGenerationOptions } from '@brainstrike/assistant-contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDesktopGenerationOptions,
  createGeneratingMessage,
  createReadyMessage,
  getDesktopLlmHost,
  handleDesktopProgressEvent,
} from '../../src/assistant-ui-panel/local-runtime-desktop-host';

describe('local runtime desktop host helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    (window as Window & { llmHost?: unknown }).llmHost = undefined;
  });

  it('resolves the preload-provided desktop LLM host', () => {
    const host = {
      generate: vi.fn(),
      warmup: vi.fn(),
    };

    Object.assign(window as Window & { llmHost?: unknown }, {
      llmHost: host,
    });

    expect(getDesktopLlmHost()).toBe(host);
  });

  it('strips abort signals from cloneable desktop generation options', () => {
    const controller = new AbortController();
    const options: LocalLlmGenerationOptions = {
      maxNewTokens: 64,
      signal: controller.signal,
      temperature: 0.25,
    };

    expect(createDesktopGenerationOptions(options)).toEqual({
      maxNewTokens: 64,
      temperature: 0.25,
    });
  });

  it('maps desktop progress events for the matching request only', () => {
    const onLoadingProgress = vi.fn();
    const onReasoningSnapshot = vi.fn();
    const onTextSnapshot = vi.fn();

    handleDesktopProgressEvent(
      {
        payload: {
          clientRequestId: 'other-request',
          kind: 'text',
          text: 'ignored',
        },
        requestId: 'host-request',
        type: 'progress',
      },
      'request-1',
      onLoadingProgress,
      onReasoningSnapshot,
      onTextSnapshot
    );
    handleDesktopProgressEvent(
      {
        payload: {
          clientRequestId: 'request-1',
          file: 'model.onnx',
          kind: 'loading',
          message: 'Downloading model',
          progress: 42,
        },
        requestId: 'host-request',
        type: 'progress',
      },
      'request-1',
      onLoadingProgress,
      onReasoningSnapshot,
      onTextSnapshot
    );
    handleDesktopProgressEvent(
      {
        payload: {
          clientRequestId: 'request-1',
          kind: 'stage',
          message: 'reasoning',
        },
        requestId: 'host-request',
        type: 'progress',
      },
      'request-1',
      onLoadingProgress,
      onReasoningSnapshot,
      onTextSnapshot
    );
    handleDesktopProgressEvent(
      {
        payload: {
          clientRequestId: 'request-1',
          kind: 'reasoning',
          reasoningText: 'Plan answer.',
        },
        requestId: 'host-request',
        type: 'progress',
      },
      'request-1',
      onLoadingProgress,
      onReasoningSnapshot,
      onTextSnapshot
    );
    handleDesktopProgressEvent(
      {
        payload: {
          clientRequestId: 'request-1',
          kind: 'text',
          text: 'Final answer.',
        },
        requestId: 'host-request',
        type: 'progress',
      },
      'request-1',
      onLoadingProgress,
      onReasoningSnapshot,
      onTextSnapshot
    );

    expect(onLoadingProgress).toHaveBeenNthCalledWith(1, {
      file: 'model.onnx',
      message: 'Downloading model',
      progress: 42,
      stage: 'loading',
    });
    expect(onLoadingProgress).toHaveBeenNthCalledWith(2, {
      message: 'Thinking...',
      progress: 0,
      stage: 'generating',
    });
    expect(onReasoningSnapshot).toHaveBeenCalledWith('Plan answer.');
    expect(onTextSnapshot).toHaveBeenCalledWith('Final answer.');
  });

  it('provides local runtime progress labels', () => {
    expect(createGeneratingMessage('reasoning')).toBe('Thinking...');
    expect(createGeneratingMessage('responding')).toBe('Generating answer...');
    expect(createReadyMessage()).toBe('Response complete.');
  });
});
