import { Socket } from 'node:net';
import { runWithTimeout } from '@brainstrike/effect-kit';
import { destroySocket, receiveFrames, sendFrame } from './frames.js';
import {
  decodeHostRecord,
  decodeReply,
  HOST_VERSION,
  type HostRecord,
  type HostReply,
  type HostRequest,
  PROTOCOL_VERSION,
} from './record.js';
import { ResourceOwner } from './resource-owner.js';

export interface HostAttachment {
  close(): Promise<void>;
  readonly closed: Promise<void>;
  readonly record: HostRecord;
}
class ReplyQueue {
  private readonly queue: HostReply[] = [];
  private waiter: ReturnType<typeof Promise.withResolvers<HostReply>> | undefined;
  private failure: unknown;
  private closeFailure: unknown;
  private readonly completion = Promise.withResolvers<void>();
  readonly closed = this.completion.promise;
  constructor(readonly socket: Socket) {
    this.closed.catch(() => undefined); // the public attachment preserves the rejection
    receiveFrames(
      socket,
      decodeReply,
      (reply) => {
        if (this.waiter) {
          const waiter = this.waiter;
          this.waiter = undefined;
          waiter.resolve(reply);
        } else {
          this.queue.push(reply);
        }
      },
      (cause) => {
        this.closeFailure = cause;
        this.fail(cause);
        socket.destroy();
      }
    );
    socket.on('error', (cause: Error) => {
      this.closeFailure = cause;
      this.fail(cause);
    });
    socket.on('close', () => {
      this.fail(new Error('Host connection closed'));
      if (this.closeFailure === undefined) {
        this.completion.resolve();
      } else {
        this.completion.reject(this.closeFailure);
      }
    });
  }
  fail(cause: unknown): void {
    this.failure ??= cause;
    this.waiter?.reject(this.failure);
    this.waiter = undefined;
  }
  async request(request: HostRequest): Promise<HostReply> {
    if (this.failure) {
      throw this.failure;
    }
    if (this.waiter) {
      throw new Error('Concurrent host handshake request');
    }
    const next = this.queue.shift();
    if (next) {
      throw new Error('Unsolicited host handshake reply');
    }
    this.waiter = Promise.withResolvers<HostReply>();
    const pending = this.waiter.promise;
    sendFrame(this.socket, request);
    const reply = await pending;
    if (reply.method === 'error') {
      throw new Error(reply.message);
    }
    return reply;
  }
}

async function connectSocket(socket: Socket, endpoint: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      socket.off('connect', connected);
      socket.off('error', failed);
      signal.removeEventListener('abort', aborted);
    };
    const connected = (): void => {
      cleanup();
      resolve();
    };
    const failed = (cause: Error): void => {
      cleanup();
      reject(cause);
    };
    const aborted = (): void => {
      cleanup();
      socket.destroy();
      reject(signal.reason);
    };
    socket.once('connect', connected);
    socket.once('error', failed);
    signal.addEventListener('abort', aborted, { once: true });
    socket.connect(endpoint);
  });
}

export async function attachHost(input: HostRecord, timeoutMs = 1500): Promise<HostAttachment> {
  const record = decodeHostRecord(input);
  if (record.protocolVersion !== PROTOCOL_VERSION || record.hostVersion !== HOST_VERSION) {
    throw new Error(`Host pid ${record.pid} has incompatible protocol or host version`);
  }
  const owner = new ResourceOwner();
  const socket = await owner.acquire(async () => new Socket(), destroySocket);
  const queue = new ReplyQueue(socket);
  try {
    await runWithTimeout(
      async (signal) => {
        const aborted = (): void => {
          queue.fail(signal.reason);
          socket.destroy();
        };
        signal.addEventListener('abort', aborted, { once: true });
        try {
          await connectSocket(socket, record.endpoint, signal);
          const initialized = await queue.request({
            hostVersion: HOST_VERSION,
            method: 'initialize',
            protocolVersion: PROTOCOL_VERSION,
            token: record.token,
          });
          if (
            initialized.method !== 'initialized' ||
            initialized.pid !== record.pid ||
            initialized.start !== record.start ||
            initialized.protocolVersion !== record.protocolVersion ||
            initialized.hostVersion !== record.hostVersion
          ) {
            throw new Error('Host initialize reply does not match its lease record');
          }
          if ((await queue.request({ method: 'attach' })).method !== 'attached') {
            throw new Error('Host did not acknowledge attach');
          }
        } finally {
          signal.removeEventListener('abort', aborted);
        }
      },
      {
        onTimeout: () => new Error(`Host pid ${record.pid} initialize/attach timed out`),
        timeoutMs,
      }
    );
    return { close: () => owner.close(), closed: queue.closed, record };
  } catch (cause) {
    try {
      await owner.close();
    } catch (cleanupCause) {
      throw new AggregateError([cause, cleanupCause], 'Host attach and cleanup failed');
    }
    throw cause;
  }
}
