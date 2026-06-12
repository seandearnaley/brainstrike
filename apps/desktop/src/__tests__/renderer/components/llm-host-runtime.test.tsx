import { render, waitFor } from '@testing-library/react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LlmHostRuntime } from '../../../renderer/components/llm-host-runtime';

const { initializeMock, generateMock, disposeMock } = vi.hoisted(() => ({
  disposeMock: vi.fn(),
  generateMock: vi.fn(),
  initializeMock: vi.fn(),
}));

vi.mock('@brainstrike/agent/local-llm', () => ({
  LocalLlmBackend: vi.fn().mockImplementation(function MockLocalLlmBackend() {
    return {
      dispose: disposeMock,
      generate: generateMock,
      initialize: initializeMock,
    };
  }),
}));

type RequestListener = (request: {
  channel: 'llm';
  payload:
    | {
        clientRequestId: string;
        kind: 'generate';
        messages: [{ content: string; role: 'user' }];
        modelId: string;
        options: Record<string, never>;
      }
    | { kind: 'cancel'; requestId: string };
  requestId: string;
  runtimeId: string;
  type: 'request';
}) => void;

function createDeferred<TValue>(): {
  promise: Promise<TValue>;
  resolve: (value: TValue) => void;
} {
  let resolvePromise: ((value: TValue) => void) | null = null;
  const promise = new Promise<TValue>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => {
      resolvePromise?.(value);
    },
  };
}

describe('LlmHostRuntime', () => {
  let onRequestCallback: RequestListener | null;
  const reportProgressMock = vi.fn();
  const reportResponseMock = vi.fn();
  const reportStatusMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    onRequestCallback = null;
    initializeMock.mockResolvedValue(undefined);

    (
      window as Window & {
        llmHost?: {
          onRequest: (callback: RequestListener) => () => void;
          reportProgress: typeof reportProgressMock;
          reportResponse: typeof reportResponseMock;
          reportStatus: typeof reportStatusMock;
        };
      }
    ).llmHost = {
      onRequest: (callback: RequestListener) => {
        onRequestCallback = callback;
        return () => {
          onRequestCallback = null;
        };
      },
      reportProgress: reportProgressMock,
      reportResponse: reportResponseMock,
      reportStatus: reportStatusMock,
    };

    window.history.replaceState({}, '', '/?mode=llm-host&runtimeId=test-runtime');
  });

  it('keeps the llm-host status active until all concurrent requests finish', async () => {
    const first = createDeferred<{
      finishReason: 'stop';
      text: string;
      usage: { completionTokens: number; promptTokens: number; totalTokens: number };
    }>();
    const second = createDeferred<{
      finishReason: 'stop';
      text: string;
      usage: { completionTokens: number; promptTokens: number; totalTokens: number };
    }>();
    generateMock
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    render(<LlmHostRuntime />);

    const requestListener = onRequestCallback;
    if (!requestListener) {
      throw new Error('Expected llm host request listener to be registered.');
    }

    await act(async () => {
      requestListener({
        type: 'request',
        channel: 'llm',
        requestId: 'req-1',
        runtimeId: 'test-runtime',
        payload: {
          kind: 'generate',
          clientRequestId: 'client-1',
          modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
          messages: [{ role: 'user', content: 'first' }],
          options: {},
        },
      });
      requestListener({
        type: 'request',
        channel: 'llm',
        requestId: 'req-2',
        runtimeId: 'test-runtime',
        payload: {
          kind: 'generate',
          clientRequestId: 'client-2',
          modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
          messages: [{ role: 'user', content: 'second' }],
          options: {},
        },
      });
    });

    await waitFor(() => {
      expect(generateMock).toHaveBeenCalledTimes(2);
    });

    await act(async () => {
      first.resolve({
        finishReason: 'stop',
        text: 'first result',
        usage: {
          completionTokens: 1,
          promptTokens: 1,
          totalTokens: 2,
        },
      });
      await Promise.resolve();
    });

    const runningIdleStatusesAfterFirstCompletion = reportStatusMock.mock.calls
      .map(([status]) => status as { active?: boolean; runtimeKind?: string; state?: string })
      .filter(
        (status) =>
          status.runtimeKind === 'llm-host' && status.state === 'running' && status.active === false
      );
    expect(runningIdleStatusesAfterFirstCompletion).toHaveLength(1);

    await act(async () => {
      second.resolve({
        finishReason: 'stop',
        text: 'second result',
        usage: {
          completionTokens: 1,
          promptTokens: 1,
          totalTokens: 2,
        },
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      const runningIdleStatuses = reportStatusMock.mock.calls
        .map(([status]) => status as { active?: boolean; runtimeKind?: string; state?: string })
        .filter(
          (status) =>
            status.runtimeKind === 'llm-host' &&
            status.state === 'running' &&
            status.active === false
        );
      expect(runningIdleStatuses).toHaveLength(2);
    });
  });

  it('resets the engine after a GPU fault and says so in the reported error', async () => {
    generateMock.mockRejectedValueOnce(new Error('operation does not support unaligned accesses'));
    disposeMock.mockResolvedValueOnce(undefined);

    render(<LlmHostRuntime />);
    const requestListener = onRequestCallback;
    if (!requestListener) {
      throw new Error('Expected llm host request listener to be registered.');
    }

    await act(async () => {
      requestListener({
        type: 'request',
        channel: 'llm',
        requestId: 'req-gpu-fault',
        runtimeId: 'test-runtime',
        payload: {
          kind: 'generate',
          clientRequestId: 'client-gpu-fault',
          modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
          messages: [{ role: 'user', content: 'hello' }],
          options: {},
        },
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(reportResponseMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          requestId: 'req-gpu-fault',
          payload: expect.objectContaining({
            errorMessage: expect.stringContaining('local model engine was reset'),
          }),
        })
      );
    });
    // The poisoned WebGPU session is disposed so the NEXT warmup/generate
    // reinitializes cleanly instead of failing forever.
    expect(disposeMock).toHaveBeenCalled();
  });

  it('does not reset the engine when a generation is merely aborted', async () => {
    generateMock.mockRejectedValueOnce(
      new DOMException('The operation was aborted.', 'AbortError')
    );

    render(<LlmHostRuntime />);
    const requestListener = onRequestCallback;
    if (!requestListener) {
      throw new Error('Expected llm host request listener to be registered.');
    }

    await act(async () => {
      requestListener({
        type: 'request',
        channel: 'llm',
        requestId: 'req-aborted',
        runtimeId: 'test-runtime',
        payload: {
          kind: 'generate',
          clientRequestId: 'client-aborted',
          modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
          messages: [{ role: 'user', content: 'hello' }],
          options: {},
        },
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(reportResponseMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', requestId: 'req-aborted' })
      );
    });
    expect(disposeMock).not.toHaveBeenCalled();
    const [errorReport] = reportResponseMock.mock.calls.at(-1) ?? [];
    expect(
      (errorReport as { payload: { errorMessage: string } }).payload.errorMessage
    ).not.toContain('engine was reset');
  });

  it('reports an error (keyed to the envelope) for requests that fail validation', async () => {
    render(<LlmHostRuntime />);

    const requestListener = onRequestCallback as unknown as (request: unknown) => void;
    if (!requestListener) {
      throw new Error('Expected llm host request listener to be registered.');
    }

    await act(async () => {
      // Missing clientRequestId — must be rejected with a report, not
      // swallowed (a silent drop leaves the main-process caller waiting out
      // its full multi-minute timeout).
      requestListener({
        type: 'request',
        channel: 'llm',
        requestId: 'main:bad-warmup-1',
        runtimeId: 'test-runtime',
        payload: {
          kind: 'warmup',
          modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
        },
      });
    });

    expect(generateMock).not.toHaveBeenCalled();
    expect(initializeMock).not.toHaveBeenCalled();
    expect(reportResponseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        requestId: 'main:bad-warmup-1',
        payload: expect.objectContaining({
          errorMessage: expect.stringContaining('clientRequestId'),
        }),
      })
    );
  });
});
