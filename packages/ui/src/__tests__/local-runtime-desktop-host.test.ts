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
        type: 'progress',
        requestId: 'host-request',
        payload: {
          clientRequestId: 'other-request',
          kind: 'text',
          text: 'ignored',
        },
      },
      'request-1',
      onLoadingProgress,
      onReasoningSnapshot,
      onTextSnapshot
    );
    handleDesktopProgressEvent(
      {
        type: 'progress',
        requestId: 'host-request',
        payload: {
          clientRequestId: 'request-1',
          file: 'model.onnx',
          kind: 'loading',
          message: 'Downloading model',
          progress: 42,
        },
      },
      'request-1',
      onLoadingProgress,
      onReasoningSnapshot,
      onTextSnapshot
    );
    handleDesktopProgressEvent(
      {
        type: 'progress',
        requestId: 'host-request',
        payload: {
          clientRequestId: 'request-1',
          kind: 'stage',
          message: 'reasoning',
        },
      },
      'request-1',
      onLoadingProgress,
      onReasoningSnapshot,
      onTextSnapshot
    );
    handleDesktopProgressEvent(
      {
        type: 'progress',
        requestId: 'host-request',
        payload: {
          clientRequestId: 'request-1',
          kind: 'reasoning',
          reasoningText: 'Plan answer.',
        },
      },
      'request-1',
      onLoadingProgress,
      onReasoningSnapshot,
      onTextSnapshot
    );
    handleDesktopProgressEvent(
      {
        type: 'progress',
        requestId: 'host-request',
        payload: {
          clientRequestId: 'request-1',
          kind: 'text',
          text: 'Final answer.',
        },
      },
      'request-1',
      onLoadingProgress,
      onReasoningSnapshot,
      onTextSnapshot
    );

    expect(onLoadingProgress).toHaveBeenNthCalledWith(1, {
      stage: 'loading',
      progress: 42,
      message: 'Downloading model',
      file: 'model.onnx',
    });
    expect(onLoadingProgress).toHaveBeenNthCalledWith(2, {
      stage: 'generating',
      progress: 0,
      message: 'Thinking...',
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
