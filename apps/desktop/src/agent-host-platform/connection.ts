import { wireDecoder, wireResultDecoder } from '@brainstrike/assistant-contract/schema-boundary';
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
import type { LentUtilityPort } from '../lent-utility';
import { UtilityPortFrameSchema } from './utility-lending-wire';

/** A platform frame, with the ports it transferred (Electron's `MessageEvent`). */
interface PlatformFrame {
  readonly data: unknown;
  readonly ports?: readonly LentUtilityPort[];
}
export interface PlatformMessagePort {
  close(): void;
  off(event: 'message', listener: (event: PlatformFrame) => void): unknown;
  off(event: 'close', listener: () => void): unknown;
  on(event: 'message', listener: (event: PlatformFrame) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  postMessage(message: unknown): void;
  start(): void;
}
/** The transferred object is a capability: validate methods and retain its identity/prototype. */
export const PlatformMessagePortSchema = Schema.declare<PlatformMessagePort>(
  (value): value is PlatformMessagePort =>
    typeof value === 'object' &&
    value !== null &&
    'close' in value &&
    typeof value.close === 'function' &&
    'off' in value &&
    typeof value.off === 'function' &&
    'on' in value &&
    typeof value.on === 'function' &&
    'postMessage' in value &&
    typeof value.postMessage === 'function' &&
    'start' in value &&
    typeof value.start === 'function'
);
const decodeUtilityPortFrame = wireResultDecoder(UtilityPortFrameSchema, { errors: 'all' });
/** Receives a utility channel end Main transferred on the platform port. */
export type ReceiveUtilityPort = (utilityId: string, port: LentUtilityPort) => void;
class MainPortReader extends AbstractMessageReader {
  private readonly port: PlatformMessagePort;
  private readonly receivePort: ReceiveUtilityPort | undefined;

  constructor(port: PlatformMessagePort, receivePort: ReceiveUtilityPort | undefined) {
    super();
    this.port = port;
    this.receivePort = receivePort;
  }
  listen(callback: DataCallback): Disposable {
    const receive = (event: PlatformFrame): void => {
      const utilityPort = this.receivePort ? decodeUtilityPortFrame(event.data) : undefined;
      if (utilityPort?._tag === 'Success') {
        const transferred = event.ports?.[0];
        if (event.ports?.length !== 1 || !transferred) {
          this.fireError(new Error('A utility port frame must carry exactly one port'));
          return;
        }
        this.receivePort?.(utilityPort.success.utilityId, transferred);
        return;
      }
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
/**
 * Private platform capabilities never share the visible client's authority channel. The host's
 * end also takes the utility channels Main lends it (`receivePort`).
 */
export function mainPlatformConnection(
  port: PlatformMessagePort,
  receivePort?: ReceiveUtilityPort
): MessageConnection {
  return createMessageConnection(new MainPortReader(port, receivePort), new MainPortWriter(port));
}
