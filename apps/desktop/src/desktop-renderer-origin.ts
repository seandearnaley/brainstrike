/**
 * The bundled renderer's scheme and document URL (BST-1999), kept in a module
 * with NO runtime imports of its own.
 *
 * `desktop-renderer-target.ts` re-exports these, so main-process consumers
 * carry on importing them from there. They live here because the ESM
 * `apps/desktop/e2e` specs need the document URL and reach it by a relative
 * import that escapes into this CommonJS-transpiled graph: anything they can
 * reach must stay free of runtime bare imports (the contract in
 * `scripts/e2e-module-format-contract.mjs`). The target module itself cannot,
 * since it normalizes paths and owns the process-wide resolved target.
 */

/** Built renderers load one document on this origin, served by `renderer-protocol.ts`. */
export const APP_RENDERER_SCHEME = 'brainstrike-app';
/** Spelled out: Node's URL gives a non-special scheme the opaque origin "null". */
export const APP_RENDERER_ORIGIN = `${APP_RENDERER_SCHEME}://bundle`;
export const APP_RENDERER_DOCUMENT_URL = `${APP_RENDERER_ORIGIN}/index.html`;
