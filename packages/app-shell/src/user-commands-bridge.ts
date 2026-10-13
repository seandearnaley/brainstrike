import {
  type BoundaryTransport,
  callBoundary,
} from '@brainstrike/assistant-contract/boundary-result';
/**
 * Structural typing + capability resolution for the desktop
 * `window.userCommands` user-defined slash command discovery bridge (the
 * composer's "/" menu, scanned from `.brainstrike/commands` +
 * `.claude/commands`).
 *
 * Capability gating (CLAUDE.md CONTEXT ACTION SYSTEM): a consumer is
 * desktop-only because it is constructed only when
 * `resolveUserCommandsBridge()` returns a fully-formed bridge. Web never sees
 * it — there is no `isElectron()` check anywhere.
 *
 * Deliberately dependency-light (logging + contract types only) so the desktop
 * preload contract test can import the required-method pin without pulling UI
 * graphs.
 */

import type { UserSlashCommandsListResult } from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';

const logger = createLogger('UserCommandsBridge');

export interface UserCommandsBridge {
  list: () => Promise<UserSlashCommandsListResult>;
}

// Compile-time exact-set proof: `satisfies Record<keyof UserCommandsBridge,
// true>` fails the build if any interface method is missing here, and excess
// keys are rejected — so the pin can never silently become a subset (or
// superset) of the interface. The runtime pin only checks preload ↔ constant;
// this closes interface ↔ constant.
const USER_COMMANDS_BRIDGE_REQUIRED_METHOD_SET = {
  list: true,
} as const satisfies Record<keyof UserCommandsBridge, true>;

/**
 * Every method name the bridge must expose to be considered fully formed.
 * Exported so the desktop preload-runtime contract test can pin the
 * `window.userCommands` `exposeInMainWorld` key set to this exact list.
 *
 * NOTE: the pin is EXACT set equality, not a subset check — every method the
 * preload exposes must be listed here. There is no such thing as an optional
 * bridge method: a preload method missing from this list (or vice versa)
 * disables the entire surface via the resolver below.
 */
export const USER_COMMANDS_BRIDGE_REQUIRED_METHODS = Object.keys(
  USER_COMMANDS_BRIDGE_REQUIRED_METHOD_SET
) as readonly (keyof UserCommandsBridge)[];

/**
 * Resolve the `window.userCommands` bridge, or `null` when it is absent (web)
 * or malformed (a present-but-broken bridge logs an error and stays absent —
 * no silent degradation).
 */
export function resolveUserCommandsBridge(): UserCommandsBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const bridge = (
    window as Window & { userCommands?: Partial<BoundaryTransport<UserCommandsBridge>> }
  ).userCommands;
  if (!bridge) {
    return null;
  }
  const missing = USER_COMMANDS_BRIDGE_REQUIRED_METHODS.filter(
    (method) => typeof bridge[method] !== 'function'
  );
  if (missing.length > 0) {
    logger.error('window.userCommands bridge is malformed; slash commands disabled', { missing });
    return null;
  }
  const transport = bridge as BoundaryTransport<UserCommandsBridge>;
  return { list: () => callBoundary(() => transport.list()) };
}
