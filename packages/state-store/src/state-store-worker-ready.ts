import type { Worker } from 'node:worker_threads';
import type { StoreSettings } from './state-store-types.js';

export interface Ready {
  readonly damage: string | null;
  readonly ready: true;
  readonly settings: StoreSettings;
}

export function waitReady(worker: Worker): Promise<Ready> {
  return new Promise((resolve, reject) => {
    const onMessage = (m: Partial<Ready>): void => {
      if (m.ready === true) {
        cleanup();
        resolve(m as Ready);
      }
    };
    const onError = (e: Error): void => {
      cleanup();
      reject(e);
    };
    const onExit = (code: number): void => {
      cleanup();
      reject(new Error(`StateStore writer worker exited during open (code ${code})`));
    };
    const cleanup = (): void => {
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
    };
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
  });
}
