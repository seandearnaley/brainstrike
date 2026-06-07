import type { PGliteOptions } from '@electric-sql/pglite';
import { PGlite } from '@electric-sql/pglite';
import { worker } from '@electric-sql/pglite/worker';
import { vector } from '@electric-sql/pglite-pgvector';

type BrainstrikePGliteWorkerInitOptions = Pick<PGliteOptions, 'dataDir' | 'relaxedDurability'>;

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
  return {
    ...(dataDir === undefined ? {} : { dataDir }),
    ...(relaxedDurability === undefined ? {} : { relaxedDurability }),
  };
}

void worker({
  async init(options) {
    const workerOptions = parseWorkerInitOptions(options);
    // PGlite engine extensions run here; client-side extensions are installed by PGliteWorker.
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
