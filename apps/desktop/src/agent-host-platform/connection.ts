import { wireDecoder } from '@brainstrike/assistant-contract/schema-boundary';
import { Schema } from 'effect';
import {
  AbstractMessageReader,
  AbstractMessageWriter,
  createMessageConnection,
  type DataCallback,
  type Disposable,
  type Message,
  type MessageConnection,
} from 'vscode-jsonrpc/node';

export interface PlatformMessagePort {
  close(): void;
  off(event: 'message', listener: (event: { readonly data: unknown }) => void): unknown;
  off(event: 'close', listener: () => void): unknown;
  on(event: 'message', listener: (event: { readonly data: unknown }) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  postMessage(message: unknown): void;
  start(): void;
}
class MainPortReader extends AbstractMessageReader {
  private readonly port: PlatformMessagePort;

  constructor(port: PlatformMessagePort) {
    super();
    this.port = port;
  }
  listen(callback: DataCallback): Disposable {
    const receive = (event: { readonly data: unknown }): void => {
      try {
        callback(
          wireDecoder(
            Schema.StructWithRest(Schema.Struct({ jsonrpc: Schema.String }), [
              Schema.Record(Schema.String, Schema.Unknown),
            ]),
            { errors: 'all', onExcessProperty: 'error' }
          )(event.data)
        );
      } catch (cause) {
        this.fireError(cause instanceof Error ? cause : new Error('Invalid platform frame'));
      }
    };
    this.port.on('message', receive);
    const closed = (): void => this.fireClose();
    this.port.on('close', closed);
    this.port.start();
    return {
      dispose: () => {
        this.port.off('message', receive);
        this.port.off('close', closed);
      },
    };
  }
}
class MainPortWriter extends AbstractMessageWriter {
  private readonly port: PlatformMessagePort;

  constructor(port: PlatformMessagePort) {
    super();
    this.port = port;
  }
  write(message: Message): Promise<void> {
    try {
      this.port.postMessage(message);
      return Promise.resolve();
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error('Platform write failed');
      this.fireError(error);
      return Promise.reject(error);
    }
  }
  end(): void {
    this.port.close();
  }
}
/** Private platform capabilities never share the visible client's authority channel. */
export function mainPlatformConnection(port: PlatformMessagePort): MessageConnection {
  return createMessageConnection(new MainPortReader(port), new MainPortWriter(port));
}
