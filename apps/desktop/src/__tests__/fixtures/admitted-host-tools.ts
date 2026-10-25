import { EventEmitter } from 'node:events';
import type { MessagePort } from 'node:worker_threads';
import type { PlatformMessagePort } from '../../agent-host-platform/connection';

/** Real Node ports with the Electron utility port's public MessageEvent shape. */
export class UtilityPort extends EventEmitter implements PlatformMessagePort {
  private readonly port: MessagePort;

  constructor(port: MessagePort) {
    super();
    this.port = port;
    port.on('message', (data: unknown) => this.emit('message', { data }));
    port.on('close', () => this.emit('close'));
  }
  start(): void {
    this.port.start();
  }
  postMessage(message: unknown): void {
    this.port.postMessage(message);
  }
  close(): void {
    this.port.close();
  }
}
