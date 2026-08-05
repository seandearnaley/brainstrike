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
export const USER_COMMANDS_BRIDGE_REQUIRED_METHODS: readonly (keyof UserCommandsBridge)[] = [
  'list',
];

/**
 * Resolve the `window.userCommands` bridge, or `null` when it is absent (web)
 * or malformed (a present-but-broken bridge logs an error and stays absent —
 * no silent degradation).
 */
export function resolveUserCommandsBridge(): UserCommandsBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const bridge = window.userCommands;
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
  return bridge as UserCommandsBridge;
}
