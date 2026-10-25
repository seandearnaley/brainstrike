import { MessageChannelMain, type MessagePortMain } from 'electron';
import type { PlatformMessagePort } from './agent-host-platform/connection';

export interface AgentHostPortRelay {
  /** Closes this client's transport, without stopping the host. */
  close(): Promise<void>;
  readonly closed: Promise<void>;
  readonly port: MessagePortMain;
}

/**
 * Relays a visible client over a channel Main opened on the host's stdio, so the
 * host admits it as the desktop origin. Closing either side
 * closes both and settles `closed`.
 */
export function openAgentHostChildRelay(hostPort: PlatformMessagePort): AgentHostPortRelay {
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
  hostPort.on('close', () => void close());
  channel.port1.once('close', () => void close());
  hostPort.start();
  channel.port1.start();
  return { close, closed: exited.promise, port: channel.port2 };
}
