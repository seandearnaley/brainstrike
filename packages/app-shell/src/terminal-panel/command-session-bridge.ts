import { createLogger } from '@brainstrike/logging';

const logger = createLogger('CommandSessionInventory');

export type CommandSessionErrorCode =
  | 'aborted'
  | 'cursor-out-of-range'
  | 'cwd-not-found'
  | 'cwd-outside-root'
  | 'internal'
  | 'invalid-buffer'
  | 'invalid-input'
  | 'root-unavailable'
  | 'session-exited'
  | 'session-id-collision'
  | 'session-not-found'
  | 'start-failed'
  | 'stop-failed'
  | 'workspace-busy';

export type CommandSessionResult<T = void> =
  | (T extends void ? { readonly ok: true } : { readonly ok: true; readonly value: T })
  | {
      readonly error: { readonly code: CommandSessionErrorCode; readonly message: string };
      readonly ok: false;
    };

interface CommandSessionBase {
  readonly createdAt: number;
  readonly cwd: string;
  readonly id: string;
  readonly pid: number;
  readonly rootId: string;
}

export type CommandSessionInfo =
  | (CommandSessionBase & { readonly status: 'running' })
  | (CommandSessionBase & {
      readonly exitCode: number;
      readonly exitedAt: number;
      readonly signal: number | null;
      readonly status: 'exited';
    });

export interface CommandSessionReadPage {
  readonly bufferStartCursor: number;
  readonly hasMore: boolean;
  readonly nextCursor: number;
  readonly output: string;
  readonly requestedCursor: number;
  readonly session: CommandSessionInfo;
  readonly truncatedBeforeCursor: boolean;
}

export interface CommandSessionIdentityParams {
  readonly rootId: string;
  readonly sessionId: string;
}

export interface CommandSessionBridge {
  readonly list: (params: { readonly rootId: string }) => Promise<
    CommandSessionResult<{
      readonly rootId: string;
      readonly sessions: readonly CommandSessionInfo[];
    }>
  >;
  readonly read: (
    params: CommandSessionIdentityParams & { readonly cursor?: number }
  ) => Promise<CommandSessionResult<CommandSessionReadPage>>;
  readonly remove: (params: CommandSessionIdentityParams) => Promise<CommandSessionResult>;
  readonly stop: (params: CommandSessionIdentityParams) => Promise<CommandSessionResult>;
  readonly write: (
    params: CommandSessionIdentityParams & { readonly data: string }
  ) => Promise<CommandSessionResult>;
}

// Compile-time exact-set proof: `satisfies Record<keyof CommandSessionBridge,
// true>` fails the build if any interface method is missing here, and excess
// keys are rejected — so the pin can never silently become a subset (or
// superset) of the interface. The runtime pin only checks preload ↔ constant;
// this closes interface ↔ constant.
const COMMAND_SESSION_BRIDGE_REQUIRED_METHOD_SET = {
  list: true,
  read: true,
  remove: true,
  stop: true,
  write: true,
} as const satisfies Record<keyof CommandSessionBridge, true>;

/**
 * Every method name the bridge must expose to be considered fully formed.
 * Exported so the desktop contract test can pin the derived preload bridge to
 * this exact package-owned surface.
 *
 * NOTE: the pin is EXACT set equality, not a subset check — every method the
 * preload exposes must be listed here. There is no such thing as an optional
 * bridge method: a preload method missing from this list (or vice versa)
 * disables the entire surface via the resolver below.
 */
export const COMMAND_SESSION_BRIDGE_REQUIRED_METHODS = Object.keys(
  COMMAND_SESSION_BRIDGE_REQUIRED_METHOD_SET
) as readonly (keyof CommandSessionBridge)[];

export function resolveCommandSessionBridge(): CommandSessionBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const bridge = (window as Window & { commandSessions?: Partial<CommandSessionBridge> })
    .commandSessions;
  if (!bridge) {
    return null;
  }
  const missing = COMMAND_SESSION_BRIDGE_REQUIRED_METHODS.filter(
    (method) => typeof bridge[method] !== 'function'
  );
  if (missing.length > 0) {
    logger.error('window.commandSessions bridge is malformed; inventory disabled', { missing });
    return null;
  }
  return bridge as CommandSessionBridge;
}

export function isCommandSessionBridgeAvailable(): boolean {
  return resolveCommandSessionBridge() !== null;
}
