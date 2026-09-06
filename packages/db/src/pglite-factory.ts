import { PGlite, type PGliteOptions } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { type LiveNamespace, live } from '@electric-sql/pglite/live';
import { pg_textsearch } from '@electric-sql/pglite-pg_textsearch';
import { vector } from '@electric-sql/pglite-pgvector';

/** Engine (WASM) extensions: identical at every construction site. */
export const ENGINE_EXTENSIONS = { pg_textsearch, pg_trgm, vector } as const;
/** Client plugins: PGliteWorker installs these on the connecting client. */
export const CLIENT_EXTENSIONS = { live } as const;

export type BrainstrikePglite = PGlite & { readonly live: LiveNamespace };

export type CreateBrainstrikePgliteOptions = Pick<
  PGliteOptions,
  'dataDir' | 'loadDataDir' | 'relaxedDurability'
>;

/** Direct hosts. Resolves only once the engine and client plugins are ready. */
export function createBrainstrikePglite(
  options?: CreateBrainstrikePgliteOptions
): Promise<BrainstrikePglite> {
  return PGlite.create({ ...options, extensions: { ...ENGINE_EXTENSIONS, ...CLIENT_EXTENSIONS } });
}

/** Worker hosts. Live queries belong to the connecting PGliteWorker client. */
export function createEnginePglite(options?: CreateBrainstrikePgliteOptions): Promise<PGlite> {
  return PGlite.create({ ...options, extensions: ENGINE_EXTENSIONS });
}
