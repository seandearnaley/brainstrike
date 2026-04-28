import type { PGliteOptions } from '@electric-sql/pglite';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { worker } from '@electric-sql/pglite/worker';

type BrainstrikePGliteWorkerInitOptions = Pick<PGliteOptions, 'dataDir' | 'relaxedDurability'> & {
  readonly id?: string;
  readonly meta?: unknown;
};

function parseWorkerInitOptions(options: unknown): BrainstrikePGliteWorkerInitOptions {
  if (typeof options !== 'object' || options === null) {
    throw new Error('PGlite worker init options must be an object');
  }
  const candidate = options as Record<string, unknown>;
  const dataDir = candidate['dataDir'];
  if (dataDir !== undefined && typeof dataDir !== 'string') {
    throw new Error('PGlite worker dataDir must be a string when provided');
  }
  const relaxedDurability = candidate['relaxedDurability'];
  if (relaxedDurability !== undefined && typeof relaxedDurability !== 'boolean') {
    throw new Error('PGlite worker relaxedDurability must be a boolean when provided');
  }
  const id = candidate['id'];
  const meta = candidate['meta'];
  return {
    ...(dataDir === undefined ? {} : { dataDir }),
    ...(relaxedDurability === undefined ? {} : { relaxedDurability }),
    ...(typeof id === 'string' ? { id } : {}),
    ...(meta === undefined ? {} : { meta }),
  };
}

void worker({
  async init(options) {
    const workerOptions = parseWorkerInitOptions(options);
    // The worker protocol includes coordination fields; only storage/runtime options belong in PGlite.
    const pgliteOptions: PGliteOptions = {
      extensions: { vector },
    };
    if (workerOptions.dataDir !== undefined) {
      pgliteOptions.dataDir = workerOptions.dataDir;
    }
    if (workerOptions.relaxedDurability !== undefined) {
      pgliteOptions.relaxedDurability = workerOptions.relaxedDurability;
    }
    return new PGlite(pgliteOptions);
  },
});
