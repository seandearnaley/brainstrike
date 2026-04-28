import type { PGliteOptions } from '@electric-sql/pglite';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { worker } from '@electric-sql/pglite/worker';

void worker({
  async init(options) {
    const pgliteOptions: PGliteOptions = {
      extensions: { vector },
    };
    if (options.dataDir !== undefined) {
      pgliteOptions.dataDir = options.dataDir;
    }
    if (options.relaxedDurability !== undefined) {
      pgliteOptions.relaxedDurability = options.relaxedDurability;
    }
    return new PGlite(pgliteOptions);
  },
});
