import type http from 'node:http';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import {
  assistantServerHttpStreamLogger,
  pumpReadableToResponse,
  readRequestBody,
  streamResponse,
  writeHeaders,
} from '../../assistant-server/http';

describe('assistant-server/http utilities', () => {
  describe('readRequestBody', () => {
    it('should read request body from IncomingMessage', async () => {
      const mockReq = {
        on: vi.fn((event: string, handler: (chunk?: unknown) => void) => {
          if (event === 'data') {
            handler('hello ');
            handler('world');
          } else if (event === 'end') {
            handler();
          }
          return mockReq;
        }),
      } as unknown as http.IncomingMessage;

      const body = await readRequestBody(mockReq);
      expect(body).toBe('hello world');
    });

    it('should handle empty request body', async () => {
      const mockReq = {
        on: vi.fn((event: string, handler: (chunk?: unknown) => void) => {
          if (event === 'end') {
            handler();
          }
          return mockReq;
        }),
      } as unknown as http.IncomingMessage;

      const body = await readRequestBody(mockReq);
      expect(body).toBe('');
    });

    it('rejects and pauses the request when chunked input exceeds the byte limit', async () => {
      let dataHandler: ((chunk: Buffer) => void) | undefined;
      let errorHandler: ((error: Error) => void) | undefined;
      const pauseMock = vi.fn();
      const destroyMock = vi.fn((error?: Error) => {
        if (error) {
          errorHandler?.(error);
        }
      });
      const mockReq = {
        destroy: destroyMock,
        on: vi.fn((event: string, handler: (chunk?: unknown) => void) => {
          if (event === 'data') {
            dataHandler = handler as (chunk: Buffer) => void;
          }
          if (event === 'error') {
            errorHandler = handler as (error: Error) => void;
          }
          return mockReq;
        }),
        pause: pauseMock,
      } as unknown as http.IncomingMessage;

      const bodyPromise = readRequestBody(mockReq, { maxBodyBytes: 5 });
      const timedBodyPromise = Promise.race([
        bodyPromise,
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('readRequestBody did not reject')), 50)
        ),
      ]);

      dataHandler?.(Buffer.from('123'));
      dataHandler?.(Buffer.from('456'));

      await expect(timedBodyPromise).rejects.toThrow('Assistant request body exceeds 5 bytes.');
      expect(pauseMock).toHaveBeenCalledOnce();
      expect(destroyMock).not.toHaveBeenCalled();
    });
  });

  describe('writeHeaders', () => {
    it('should write all headers to ServerResponse', () => {
      const setHeaderMock = vi.fn();
      const mockRes = {
        setHeader: setHeaderMock,
      } as unknown as http.ServerResponse;

      const headers = new Headers({
        'Content-Type': 'application/json',
        'X-Custom': 'value',
      });

      writeHeaders(mockRes, headers);

      expect(setHeaderMock).toHaveBeenCalledWith('content-type', 'application/json');
      expect(setHeaderMock).toHaveBeenCalledWith('x-custom', 'value');
    });

    it('should silently ignore header errors', () => {
      const setHeaderMock = vi.fn(() => {
        throw new Error('Header error');
      });
      const mockRes = {
        setHeader: setHeaderMock,
      } as unknown as http.ServerResponse;

      const headers = new Headers({ 'X-Test': 'value' });

      expect(() => writeHeaders(mockRes, headers)).not.toThrow();
      expect(setHeaderMock).toHaveBeenCalled();
    });
  });

  describe('streamResponse', () => {
    let mockRes: http.ServerResponse;

    beforeEach(() => {
      mockRes = {
        setHeader: vi.fn(),
        writeHead: vi.fn(),
        end: vi.fn(),
        write: vi.fn(() => true),
        destroyed: false,
      } as unknown as http.ServerResponse;
    });

    it('should write headers and status code', async () => {
      const response = {
        status: 200,
        headers: new Headers({ 'Content-Type': 'text/plain' }),
        body: null,
      };

      await streamResponse(mockRes, response);

      expect(mockRes.setHeader).toHaveBeenCalledWith('content-type', 'text/plain');
      expect(mockRes.setHeader).toHaveBeenCalledWith('Connection', 'close');
      expect(mockRes.writeHead).toHaveBeenCalledWith(200);
      expect(mockRes.end).toHaveBeenCalled();
    });

    it('should handle null body', async () => {
      const response = {
        status: 204,
        headers: new Headers(),
        body: null,
      };

      await streamResponse(mockRes, response);

      expect(mockRes.end).toHaveBeenCalled();
    });

    it('should stream body chunks', async () => {
      const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])];
      const stream = new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(chunk);
          }
          controller.close();
        },
      });

      const response = {
        status: 200,
        headers: new Headers(),
        body: stream,
      };

      await streamResponse(mockRes, response);

      expect(mockRes.write).toHaveBeenCalledWith(chunks[0]);
      expect(mockRes.write).toHaveBeenCalledWith(chunks[1]);
      expect(mockRes.end).toHaveBeenCalled();
    });

    it('should handle Connection header error silently', async () => {
      const setHeaderMock = vi.fn((key: string) => {
        if (key === 'Connection') {
          throw new Error('Cannot set Connection header');
        }
      });

      const mockResWithError = {
        ...mockRes,
        setHeader: setHeaderMock,
      } as unknown as http.ServerResponse;

      const response = {
        status: 200,
        headers: new Headers(),
        body: null,
      };

      await expect(streamResponse(mockResWithError, response)).resolves.not.toThrow();
      expect(mockResWithError.end).toHaveBeenCalled();
    });
  });

  describe('pumpReadableToResponse', () => {
    let mockRes: http.ServerResponse;

    beforeEach(() => {
      mockRes = {
        write: vi.fn(() => true),
        end: vi.fn(),
        once: vi.fn(),
        destroyed: false,
        flushHeaders: vi.fn(),
      } as unknown as http.ServerResponse;
    });

    it('should pump all chunks from stream to response', async () => {
      const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4])];
      const stream = new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(chunk);
          }
          controller.close();
        },
      });

      await pumpReadableToResponse(stream, mockRes);

      expect(mockRes.write).toHaveBeenCalledTimes(2);
      expect(mockRes.write).toHaveBeenCalledWith(chunks[0]);
      expect(mockRes.write).toHaveBeenCalledWith(chunks[1]);
      expect(mockRes.end).toHaveBeenCalled();
    });

    it('should stop pumping on abort signal', async () => {
      const abortController = new AbortController();
      let chunkCount = 0;

      const stream = new ReadableStream({
        async start(controller) {
          for (let i = 0; i < 10; i++) {
            if (i === 2) {
              abortController.abort();
            }
            controller.enqueue(new Uint8Array([i]));
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          controller.close();
        },
      });

      await pumpReadableToResponse(stream, mockRes, abortController.signal);

      // Should have stopped early due to abort
      chunkCount = (mockRes.write as Mock).mock.calls.length;
      expect(chunkCount).toBeLessThanOrEqual(3);
      expect(mockRes.end).toHaveBeenCalled();
    });

    it('should handle backpressure with drain event', async () => {
      let drainCallback: (() => void) | undefined;
      const mockResBackpressure = {
        write: vi.fn(() => false), // Simulate backpressure
        once: vi.fn((event: string, cb: () => void) => {
          if (event === 'drain') {
            drainCallback = cb;
            setTimeout(() => drainCallback?.(), 10);
          }
        }),
        end: vi.fn(),
        destroyed: false,
        flushHeaders: vi.fn(),
      } as unknown as http.ServerResponse;

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
          controller.close();
        },
      });

      await pumpReadableToResponse(stream, mockResBackpressure);

      expect(mockResBackpressure.write).toHaveBeenCalled();
      expect(mockResBackpressure.once).toHaveBeenCalledWith('drain', expect.any(Function));
      expect(mockResBackpressure.end).toHaveBeenCalled();
    });

    it('should skip empty chunks', async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([])); // Empty chunk
          controller.enqueue(new Uint8Array([1, 2])); // Non-empty chunk
          controller.close();
        },
      });

      await pumpReadableToResponse(stream, mockRes);

      expect(mockRes.write).toHaveBeenCalledTimes(1);
      expect(mockRes.write).toHaveBeenCalledWith(new Uint8Array([1, 2]));
    });

    it('should surface stream errors after ending the response', async () => {
      const loggerErrorSpy = vi
        .spyOn(assistantServerHttpStreamLogger, 'error')
        .mockImplementation(() => {});
      const stream = new ReadableStream({
        start(controller) {
          controller.error(new Error('Stream error'));
        },
      });

      await expect(pumpReadableToResponse(stream, mockRes)).rejects.toThrow('Stream error');

      expect(loggerErrorSpy).toHaveBeenCalledWith(
        'Stream pipeline failed',
        expect.objectContaining({ error: expect.any(Error) })
      );
      expect(mockRes.end).toHaveBeenCalled();

      loggerErrorSpy.mockRestore();
    });

    it('should not log errors if aborted', async () => {
      const loggerErrorSpy = vi
        .spyOn(assistantServerHttpStreamLogger, 'error')
        .mockImplementation(() => {});
      const abortController = new AbortController();
      abortController.abort();

      const stream = new ReadableStream({
        start(controller) {
          controller.error(new Error('Stream error'));
        },
      });

      await pumpReadableToResponse(stream, mockRes, abortController.signal);

      expect(loggerErrorSpy).not.toHaveBeenCalled();
      loggerErrorSpy.mockRestore();
    });

    it('should not log errors if response destroyed', async () => {
      const loggerErrorSpy = vi
        .spyOn(assistantServerHttpStreamLogger, 'error')
        .mockImplementation(() => {});
      const mockResDestroyed = {
        ...mockRes,
        destroyed: true,
      } as unknown as http.ServerResponse;

      const stream = new ReadableStream({
        start(controller) {
          controller.error(new Error('Stream error'));
        },
      });

      await pumpReadableToResponse(stream, mockResDestroyed);

      expect(loggerErrorSpy).not.toHaveBeenCalled();
      loggerErrorSpy.mockRestore();
    });

    it('should stop if response destroyed during pumping', async () => {
      let writeCount = 0;
      const mockResDynamic = {
        write: vi.fn(() => {
          writeCount++;
          return true;
        }),
        end: vi.fn(),
        destroyed: false,
        flushHeaders: vi.fn(),
      } as unknown as http.ServerResponse;

      Object.defineProperty(mockResDynamic, 'destroyed', {
        configurable: true,
        get() {
          return writeCount >= 2;
        },
      });

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
          controller.enqueue(new Uint8Array([2]));
          controller.enqueue(new Uint8Array([3]));
          controller.close();
        },
      });

      await pumpReadableToResponse(stream, mockResDynamic);

      // Should write at least one chunk before stopping
      expect(mockResDynamic.write).toHaveBeenCalled();
    });

    it('should handle abort signal pre-aborted', async () => {
      const abortController = new AbortController();
      abortController.abort(); // Pre-abort

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
          controller.close();
        },
      });

      await pumpReadableToResponse(stream, mockRes, abortController.signal);

      expect(mockRes.end).toHaveBeenCalled();
    });

    it('should cleanup event listeners on completion', async () => {
      const _abortController = new AbortController();
      const addEventListenerSpy = vi.fn();
      const removeEventListenerSpy = vi.fn();

      // Create a proper AbortSignal mock with all required methods
      const mockSignal = {
        aborted: false,
        reason: undefined,
        throwIfAborted: vi.fn(),
        addEventListener: addEventListenerSpy,
        removeEventListener: removeEventListenerSpy,
        dispatchEvent: vi.fn(),
        onabort: null,
      } as unknown as AbortSignal;

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
          controller.close();
        },
      });

      await pumpReadableToResponse(stream, mockRes, mockSignal);

      expect(addEventListenerSpy).toHaveBeenCalledWith('abort', expect.any(Function), {
        once: true,
      });
      expect(removeEventListenerSpy).toHaveBeenCalledWith('abort', expect.any(Function));
    });
  });
});
