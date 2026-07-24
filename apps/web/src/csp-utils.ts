/**
 * Content Security Policy for the web app.
 *
 * Thin wrapper over the shared builder in `@brainstrike/platform-utils`
 * (BST-745). The web-vs-electron deltas live there, parameterized by target;
 * this file just pins the `'web'` target so consumers keep the same
 * `getCSP`/`getDevCSP` API.
 */
import { type CspEnvironment, getContentSecurityPolicy } from '@brainstrike/platform-utils';

/**
 * Get CSP string for the given environment.
 */
export function getCSP(env: CspEnvironment): string {
  return getContentSecurityPolicy(env, 'web');
}

/**
 * Get development CSP string.
 */
export function getDevCSP(): string {
  return getCSP('development');
}
