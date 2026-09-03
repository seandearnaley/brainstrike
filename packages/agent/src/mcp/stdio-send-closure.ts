import type { Transport } from '@modelcontextprotocol/client';

/**
 * Settles the sends of one owned stdio transport when its connection closes.
 *
 * Node's parent-side pipe to a child that has exited (or that closed its own
 * read end) accepts no further writes: `net.Socket.write()` returns `false`
 * and `'drain'` never fires again. The official SDK's
 * `StdioClientTransport.send()` resolves only on that `'drain'`, so a message
 * written into a dead child's pipe returns a promise that NEVER settles.
 *
 * `Protocol.request()` survives that because it does not await the send — its
 * response handler is settled by `Protocol._onclose`. `Client.listen()` does
 * NOT: it awaits `transport.send()` BEFORE it attaches a handler to its own
 * internal `opening` promise. A child that dies in that window therefore
 * leaves `subscriptions/listen` hung forever (which hangs the whole connect
 * sequence and orphans the client), and lets `Client._onclose`'s
 * `SdkError: Connection closed` escape as an unhandled rejection in Electron
 * main (BST-1600).
 *
 * Terminal closure must therefore reject the in-flight sends itself. This is a
 * visible failure, never a silent one: the send rejects with the closure cause
 * so `listen()` settles and the host classifies it like any other lifecycle
 * failure.
 */
export interface McpStdioSendClosure {
  /**
   * Rejects every in-flight send, and every later send, with `cause`.
   * Idempotent; the first cause wins.
   */
  close(cause: Error): void;
}

/**
 * Wraps `transport.send` in place. Call before the transport is started so no
 * message can be written outside the closure's bookkeeping.
 */
export function installMcpStdioSendClosure(transport: Transport): McpStdioSendClosure {
  const pending = new Set<(cause: Error) => void>();
  let closedCause: Error | undefined;
  const send = transport.send.bind(transport);
  transport.send = async (message, options) => {
    if (closedCause) {
      throw closedCause;
    }
    const abandoned = Promise.withResolvers<never>();
    pending.add(abandoned.reject);
    try {
      // The losing leg is the SDK's own send promise, which by construction can
      // never settle once the pipe is gone; it resolves to nothing and holds
      // only this transport's already-discarded closure.
      await Promise.race([send(message, options), abandoned.promise]);
    } finally {
      pending.delete(abandoned.reject);
    }
  };
  return {
    close(cause) {
      closedCause ??= cause;
      const terminal = closedCause;
      for (const reject of [...pending]) {
        pending.delete(reject);
        reject(terminal);
      }
    },
  };
}
