/**
 * The snapshot verifier's PGlite (BST-1877), in its own module and subpath
 * (`@brainstrike/db/pglite-verification-factory`) so `amcheck` is reachable only
 * from the desktop DB tool process and never from a browser bundle. It still
 * spreads the ONE engine set, so every construction site loads the full
 * extension set. It carries no client plugin: the verifier serves no reactive
 * queries. `scripts/__tests__/pglite-factory-contract.test.mjs` pins who may
 * import it.
 */
import { PGlite } from '@electric-sql/pglite';
import { amcheck } from '@electric-sql/pglite/contrib/amcheck';
import { type CreateBrainstrikePgliteOptions, ENGINE_EXTENSIONS } from './pglite-factory.js';

export const VERIFICATION_EXTENSIONS = { ...ENGINE_EXTENSIONS, amcheck } as const;

/** Resolves only once the engine and `amcheck` are ready. */
export function createVerificationPglite(
  options?: CreateBrainstrikePgliteOptions
): Promise<PGlite> {
  return PGlite.create({ ...options, extensions: VERIFICATION_EXTENSIONS });
}
