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
  return value.trim();
}

function reportTransportFailure(context: string, error: unknown): void {
  // biome-ignore lint/suspicious/noConsole: this worker IS part of the logger; the raw console target is the only independent failure channel.
  console.error(`[main-log-transport] ${context}`, error);
}

/**
 * Pino worker-thread transport for the full desktop INFO log. Pino supplies
 * complete NDJSON chunks; this adapter preserves those bytes and delegates
 * only size/count retention to the same file sink used by the warn+ backstop.
 */
export default function createMainLogTransport(options: MainLogTransportOptions): Writable {
  const sink = new RotatingFileSink({
    filePath: requireDestination(options.destination),
    onFailure: (error) => {
      reportTransportFailure('rotating file sink disabled after a write failure', error);
    },
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
          // Pino should delimit every record. If the worker stream ends with
          // a partial record, preserve those bytes intentionally so the
          // established tail-reader contract can identify and skip it.
          sink.writeChunk(pending);
          pending = Buffer.alloc(0);
        }
        sink.close();
      } catch (error) {
        reportTransportFailure('failed to close the rotating file sink', error);
      }
      callback();
    },
    write(chunk: Buffer, _encoding, callback): void {
      const input =
        pending.byteLength === 0
          ? chunk
          : Buffer.concat([pending, chunk], pending.length + chunk.length);
      let recordStart = 0;
      let newlineIndex = input.indexOf(0x0a, recordStart);
      const completeRecords: Buffer[] = [];
      while (newlineIndex !== -1) {
        completeRecords.push(input.subarray(recordStart, newlineIndex + 1));
        recordStart = newlineIndex + 1;
        newlineIndex = input.indexOf(0x0a, recordStart);
      }
      sink.writeRecordChunks(completeRecords);
      pending = Buffer.from(input.subarray(recordStart));
      callback();
    },
  });
}
