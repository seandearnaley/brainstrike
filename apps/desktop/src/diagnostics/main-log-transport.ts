import { Writable } from 'node:stream';
import { RotatingFileSink } from './rotating-file-sink';

interface MainLogTransportOptions {
  readonly append?: boolean;
  readonly destination?: unknown;
  readonly maxBytes?: number;
  readonly maxFiles?: number;
  readonly mkdir?: boolean;
}

function requireDestination(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('main-log-transport: destination must be a non-empty string');
  }
  return value;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('main-log-transport failed', { cause: error });
}

/**
 * Pino worker-thread transport for the full desktop INFO log. Pino supplies
 * complete NDJSON chunks; this adapter preserves those bytes and delegates
 * only size/count retention to the same file sink used by the warn+ backstop.
 */
export default function createMainLogTransport(options: MainLogTransportOptions): Writable {
  const sink = new RotatingFileSink({
    filePath: requireDestination(options.destination),
    ...(options.append === undefined ? {} : { append: options.append }),
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    ...(options.maxFiles === undefined ? {} : { maxFiles: options.maxFiles }),
    ...(options.mkdir === undefined ? {} : { mkdir: options.mkdir }),
  });
  let pending = Buffer.alloc(0);

  return new Writable({
    final(callback): void {
      try {
        if (pending.byteLength > 0) {
          sink.writeChunk(pending);
          pending = Buffer.alloc(0);
          if (sink.disabled) {
            callback(asError(sink.failure));
            return;
          }
        }
        sink.close();
        callback();
      } catch (error) {
        callback(asError(error));
      }
    },
    write(chunk: Buffer, _encoding, callback): void {
      const input =
        pending.byteLength === 0
          ? chunk
          : Buffer.concat([pending, chunk], pending.length + chunk.length);
      let recordStart = 0;
      let newlineIndex = input.indexOf(0x0a, recordStart);
      while (newlineIndex !== -1) {
        sink.writeChunk(input.subarray(recordStart, newlineIndex + 1));
        if (sink.disabled) {
          callback(asError(sink.failure));
          return;
        }
        recordStart = newlineIndex + 1;
        newlineIndex = input.indexOf(0x0a, recordStart);
      }
      pending = Buffer.from(input.subarray(recordStart));
      callback();
    },
  });
}
