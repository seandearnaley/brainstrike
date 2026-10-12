import { Socket } from 'node:net';
import type { HostRecord } from '@brainstrike/host-lease';
import { MessageChannelMain, type MessagePortMain } from 'electron';
import { type Message, StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node';

export interface AgentHostPortRelay {
  /** Closes this client transport and joins its socket, without stopping the root host. */
  close(): Promise<void>;
  readonly closed: Promise<void>;
  readonly port: MessagePortMain;
}

/**
 * Desktop main transfers a client port; the existing Node host authenticates
 * and dispatches every JSON-RPC message. This relay owns no run or root lease.
 */
export async function openAgentHostPortRelay(record: HostRecord): Promise<AgentHostPortRelay> {
  const socket = new Socket();
  const channel = new MessageChannelMain();
  const reader = new StreamMessageReader(socket);
  const writer = new StreamMessageWriter(socket);
  const connected = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<void>();
  const close = (): Promise<void> => {
    socket.destroy();
    return exited.promise;
  };
  const receive = (event: { readonly data: unknown }): void => {
    // The public stream writer owns framing. A transport failure closes this
    // client rather than dispatching an alternate command or replacing the host.
    Promise.resolve()
      .then(() => writer.write(event.data as Message))
      .catch(() => close());
  };
  const listening = reader.listen((message) => channel.port1.postMessage(message));
  channel.port1.on('message', receive);
  channel.port1.once('close', () => socket.destroy());
  channel.port1.start();
  socket.once('connect', () => connected.resolve());
  socket.on('error', (cause: Error) => {
    connected.reject(cause);
    socket.destroy();
  });
  socket.once('close', () => {
    connected.reject(new Error('Agent host transport closed before connection'));
    channel.port1.off('message', receive);
    listening.dispose();
    reader.dispose();
    writer.dispose();
    channel.port1.close();
    exited.resolve();
  });
  try {
    socket.connect(record.endpoint);
    await connected.promise;
    return { close, closed: exited.promise, port: channel.port2 };
  } catch (cause) {
    channel.port2.close();
    await close();
    throw cause;
  }
}

/**
 * Relays a visible client over a port the host received on its private parent
 * channel, so the host admits it as the desktop origin. Closing either side
 * closes both and settles `closed`.
 */
export function openAgentHostChildRelay(hostPort: MessagePortMain): AgentHostPortRelay {
  const channel = new MessageChannelMain();
  const exited = Promise.withResolvers<void>();
  let open = true;
  const close = (): Promise<void> => {
    if (open) {
      open = false;
      hostPort.close();
      channel.port1.close();
      exited.resolve();
    }
    return exited.promise;
  };
  hostPort.on('message', (event) => channel.port1.postMessage(event.data));
  channel.port1.on('message', (event) => hostPort.postMessage(event.data));
  hostPort.once('close', () => void close());
  channel.port1.once('close', () => void close());
  hostPort.start();
  channel.port1.start();
  return { close, closed: exited.promise, port: channel.port2 };
}
