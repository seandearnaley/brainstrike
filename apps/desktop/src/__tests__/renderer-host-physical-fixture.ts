import type { EventEmitter } from 'node:events';
import { vi } from 'vitest';

/** Controlled port fixture: destruction is not settlement until an explicit Electron receipt. */
export function physicalRendererFixture<TStatus>(
  window: EventEmitter & {
    destroy(): void;
    isDestroyed(): boolean;
    readonly webContents: EventEmitter;
  },
  status: () => TStatus
) {
  const physical = Promise.withResolvers<void>();
  const contents = window.webContents;
  let closed = false;
  const receipt = (): void => {
    window.removeListener('closed', receipt);
    contents.removeListener('render-process-gone', receipt);
    closed = true;
    physical.resolve();
  };
  window.once('closed', receipt);
  contents.once('render-process-gone', receipt);
  const retire = vi.fn(async () => {
    if (!(closed || window.isDestroyed())) {
      window.destroy();
    }
    await physical.promise;
  });
  return {
    acceptsStatus: vi.fn(() => true),
    destroyHostWindow: retire,
    getHostWindow: () => (closed ? null : window),
    joinPhysicalClose: vi.fn(() => physical.promise),
    restart: vi.fn(async () => status()),
    retire,
    stop: vi.fn(async (protocol?: () => Promise<void>) => {
      const failures: unknown[] = [];
      try {
        if (!(closed || window.isDestroyed())) {
          await protocol?.();
        }
      } catch (cause) {
        failures.push(cause);
      }
      try {
        await retire();
      } catch (cause) {
        failures.push(cause);
      }
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, 'Stop and physical release failed');
      }
    }),
  };
}
