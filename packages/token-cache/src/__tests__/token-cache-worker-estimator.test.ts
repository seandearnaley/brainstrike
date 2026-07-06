import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TokenWorkerRequest, TokenWorkerResponse } from '../types';

type MessageListener = (event: MessageEvent<unknown>) => void;

function createWorkerSelfMock() {
  let messageListener: MessageListener | null = null;
  const selfMock = {
    addEventListener: vi.fn((type: string, listener: MessageListener) => {
      if (type === 'message') {
        messageListener = listener;
      }
    }),
    postMessage: vi.fn(),
  };

  return {
    dispatchMessage(data: TokenWorkerRequest) {
      messageListener?.({ data } as MessageEvent<unknown>);
    },
    selfMock,
  };
}

afterEach(() => {
  vi.doUnmock('xxhash-wasm');
  vi.doUnmock('../token-utils-lite');
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('token-cache.worker estimator counting', () => {
  it('counts legacy accurate requests without loading accurate token utilities', async () => {
    const { dispatchMessage, selfMock } = createWorkerSelfMock();
    vi.stubGlobal('self', selfMock);
    vi.doMock('xxhash-wasm', () => ({
      default: async () => ({
        create64: () => ({
          update: vi.fn(),
          digest: () => 1n,
        }),
        h64: () => 1n,
      }),
    }));
    vi.doMock('../token-utils-lite', () => {
      throw new Error('accurate token utility module should not load for local estimation');
    });

    await import('../token-cache.worker');

    dispatchMessage({
      type: 'request',
      requestId: 'request-1',
      method: 'countTokens',
      params: [{ id: 'text-1', content: 'abcde', mode: 'accurate' }],
    });

    await vi.waitFor(() => {
      expect(selfMock.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'response',
          requestId: 'request-1',
          result: expect.objectContaining({
            id: 'text-1',
            mode: 'accurate',
            tokenCount: 1,
            contentHash: '0000000000000001',
          }),
        }) satisfies TokenWorkerResponse
      );
    });
  });
});
