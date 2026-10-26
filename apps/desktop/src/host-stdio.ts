import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { makeThrowingDecoder } from '@brainstrike/effect-kit';
import { Schema } from 'effect';
import type { PlatformMessagePort } from './agent-host-platform/connection';

/**
 * The headless agent host's stdin and stdout: one JSON-RPC notification per line, as
 * `codex app-server` speaks to Codex Desktop. Each connection to the host (Main's
 * platform, Main's own client, each window's client) is a channel its client opens;
 * the host's own reports and Main's controls are `host/message` notifications. The host ends when
 * its stdin ends.
 */
const ChannelSchema = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/));
const FrameSchema = Schema.Union([
  Schema.Struct({
    jsonrpc: Schema.Literal('2.0'),
    method: Schema.Literals(['channel/open', 'channel/close']),
    params: Schema.Struct({ channel: ChannelSchema }),
  }),
  Schema.Struct({
    jsonrpc: Schema.Literal('2.0'),
    method: Schema.Literal('channel/message'),
    params: Schema.Struct({ channel: ChannelSchema, message: Schema.Unknown }),
  }),
  Schema.Struct({
    jsonrpc: Schema.Literal('2.0'),
    method: Schema.Literal('host/message'),
    params: Schema.Unknown,
  }),
]);
type Frame = typeof FrameSchema.Type;
const decodeFrame = makeThrowingDecoder(FrameSchema, { onExcessProperty: 'error' });

type MessageListener = (event: { readonly data: unknown }) => void;
/** A close listener takes nothing; it is called as a message listener with no data. */
type CloseListener = () => void;

/** One channel's end, shaped as the MessagePort its JSON-RPC connection reads and writes. */
class StdioChannel implements PlatformMessagePort {
  readonly #messages = new Set<MessageListener>();
  readonly #closes = new Set<MessageListener>();
  readonly #queued: unknown[] = [];
  readonly #send: (frame: Frame) => void;
  readonly #forget: () => void;
  readonly channel: string;
  #started = false;
  #closed = false;

  constructor(channel: string, send: (frame: Frame) => void, forget: () => void) {
    this.channel = channel;
    this.#send = send;
    this.#forget = forget;
  }
  on(event: 'message', listener: MessageListener): this;
  on(event: 'close', listener: CloseListener): this;
  on(event: 'message' | 'close', listener: MessageListener): this {
    if (event === 'close' && this.#closed) {
      // A channel that already closed still tells a late listener, so no waiter on it hangs.
      queueMicrotask(() => listener({ data: undefined }));
      return this;
    }
    (event === 'message' ? this.#messages : this.#closes).add(listener);
    return this;
  }
  off(event: 'message', listener: MessageListener): this;
  off(event: 'close', listener: CloseListener): this;
  off(event: 'message' | 'close', listener: MessageListener): this {
    (event === 'message' ? this.#messages : this.#closes).delete(listener);
    return this;
  }
  postMessage(message: unknown): void {
    if (this.#closed) {
      throw new Error(`Host channel ${this.channel} is closed`);
    }
    this.#send({
      jsonrpc: '2.0',
      method: 'channel/message',
      params: { channel: this.channel, message },
    });
  }
  start(): void {
    this.#started = true;
    for (const data of this.#queued.splice(0)) {
      this.#deliver(data);
    }
  }
  close(): void {
    if (this.#closed) {
      return;
    }
    this.#send({ jsonrpc: '2.0', method: 'channel/close', params: { channel: this.channel } });
    this.ended();
  }
  received(data: unknown): void {
    if (this.#started) {
      this.#deliver(data);
    } else {
      this.#queued.push(data);
    }
  }
  /** The other end closed it, or the pipe ended. */
  ended(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#queued.length = 0;
    this.#forget();
    for (const listener of [...this.#closes]) {
      listener({ data: undefined });
    }
  }
  #deliver(data: unknown): void {
    for (const listener of [...this.#messages]) {
      listener({ data });
    }
  }
}

export interface HostStdio {
  /** Ends this end's output: Main closing the host's stdin asks the host to close. */
  end(): void;
  /** This end's input ended (the other end closed its output or exited); every channel is closed. */
  readonly ended: Promise<void>;
  /** Sends a `host/message`: the host's report, or Main's control; resolves once written. */
  message(params: unknown): Promise<void>;
  /**
   * Opens a channel to the other end, which receives it as `opened`. Once this end's input has
   * ended, the channel comes back closed.
   */
  open(channel: string): PlatformMessagePort;
}
export interface HostStdioHandlers {
  /** A frame that is not this protocol: the other end is broken, and this end stops reading. */
  readonly invalid: (cause: unknown) => void;
  readonly message: (params: unknown) => void;
  readonly opened?: (channel: string, port: PlatformMessagePort) => void;
}

/** One end of the host's stdio: `input` is what the other end writes, `output` what it reads. */
export function openHostStdio(
  input: Readable,
  output: Writable,
  handlers: HostStdioHandlers
): HostStdio {
  const channels = new Map<string, StdioChannel>();
  const ended = Promise.withResolvers<void>();
  let inputEnded = false;
  let writable = true;
  const write = (frame: Frame): Promise<void> => {
    if (!writable) {
      return Promise.reject(new Error('Host stdio output has ended'));
    }
    return new Promise<void>((resolve, reject) => {
      output.write(`${JSON.stringify(frame)}\n`, (cause) => (cause ? reject(cause) : resolve()));
    });
  };
  const send = (frame: Frame): void => {
    // A write after the pipe broke is the other end's exit, which `ended` reports.
    write(frame).catch(() => undefined);
  };
  const channel = (id: string): StdioChannel => {
    const created = new StdioChannel(id, send, () => {
      if (channels.get(id) === created) {
        channels.delete(id);
      }
    });
    channels.set(id, created);
    return created;
  };
  // The other end exiting breaks the pipe; its exit is reported by the process owner.
  output.on('error', () => {
    writable = false;
  });
  const lines = createInterface({ crlfDelay: Number.POSITIVE_INFINITY, input });
  lines.on('line', (line) => {
    if (line === '') {
      return;
    }
    let frame: Frame;
    try {
      frame = decodeFrame(JSON.parse(line));
    } catch (cause) {
      lines.close();
      handlers.invalid(new Error(`Invalid host stdio frame: ${line.slice(0, 200)}`, { cause }));
      return;
    }
    if (frame.method === 'host/message') {
      handlers.message(frame.params);
    } else if (frame.method === 'channel/open') {
      if (channels.has(frame.params.channel) || !handlers.opened) {
        send({ jsonrpc: '2.0', method: 'channel/close', params: frame.params });
        return;
      }
      handlers.opened(frame.params.channel, channel(frame.params.channel));
    } else if (frame.method === 'channel/message') {
      channels.get(frame.params.channel)?.received(frame.params.message);
    } else {
      channels.get(frame.params.channel)?.ended();
    }
  });
  lines.once('close', () => {
    inputEnded = true;
    for (const open of [...channels.values()]) {
      open.ended();
    }
    ended.resolve();
  });
  return {
    end: () => {
      writable = false;
      output.end();
    },
    ended: ended.promise,
    message: (params) => write({ jsonrpc: '2.0', method: 'host/message', params }),
    open: (id) => {
      if (channels.has(id)) {
        throw new Error(`Host channel ${id} is already open`);
      }
      const opened = channel(id);
      if (inputEnded) {
        // The other end is gone: the channel is born closed instead of waiting on nobody.
        opened.ended();
        return opened;
      }
      send({ jsonrpc: '2.0', method: 'channel/open', params: { channel: id } });
      return opened;
    },
  };
}
