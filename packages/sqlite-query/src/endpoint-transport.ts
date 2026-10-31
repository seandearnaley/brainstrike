import {
  AbstractMessageReader,
  AbstractMessageWriter,
  type DataCallback,
  Disposable,
  type Message,
  type MessageWriter,
} from 'vscode-jsonrpc/node';

function isJsonRpc(message: unknown): message is Message {
  return (
    typeof message === 'object' &&
    message !== null &&
    'jsonrpc' in message &&
    message.jsonrpc === '2.0'
  );
}

/**
 * JSON-RPC frames from a message endpoint (an IPC channel or an Electron port). It never closes
 * by itself: the owner of the endpoint decides when it ended. A frame that is not JSON-RPC is a
 * protocol fault, reported on `onError`.
 */
export class EndpointMessageReader extends AbstractMessageReader {
  #callback: DataCallback | undefined;

  listen(callback: DataCallback): Disposable {
    this.#callback = callback;
    return Disposable.create(() => {
      this.#callback = undefined;
    });
  }

  deliver(message: unknown): void {
    if (!isJsonRpc(message)) {
      this.fireError(new TypeError('SQLite query peer sent a frame that is not JSON-RPC.'));
      return;
    }
    this.#callback?.(message);
  }
}

/** JSON-RPC frames to a message endpoint; a refused post is reported on `onError` and rejects. */
export class EndpointMessageWriter extends AbstractMessageWriter implements MessageWriter {
  readonly #post: (message: Message) => void;

  constructor(post: (message: Message) => void) {
    super();
    this.#post = post;
  }

  write(message: Message): Promise<void> {
    try {
      this.#post(message);
      return Promise.resolve();
    } catch (error) {
      this.fireError(error, message);
      return Promise.reject(error);
    }
  }

  end(): void {}
}
