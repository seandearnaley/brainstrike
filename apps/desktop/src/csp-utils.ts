/**
 * Content Security Policy for the Electron desktop app.
 *
 * Thin wrapper over the shared builder in `@brainstrike/platform-utils`
 * (BST-745). The web-vs-electron deltas — the `brainstrike-asset:` protocol,
 * direct embedding-provider origins, the local assistant-server origins, and the
 * BST-573 no-CDN-in-script-src / wasm-only-eval posture — live there,
 * parameterized by target; this file pins the `'electron'` target so consumers
 * (Electron session setup, Vite dev server) keep the same `getCSP`/`getDevCSP`
 * API.
 */
import { type CspEnvironment, getContentSecurityPolicy } from '@brainstrike/platform-utils';

/**
 * Get Content Security Policy string for the given environment.
 * Primary entry point for configuring the Electron session and Vite dev server.
 */
export function getCSP(env: CspEnvironment): string {
  return getContentSecurityPolicy(env, 'electron');
}

/**
 * Get development-mode Content Security Policy.
 * Helper for Vite config where environment is implicitly development.
 * @internal Vite consumes the development policy; CSP regressions pin its restrictions.
 */
export function getDevCSP(): string {
  return getCSP('development');
}
