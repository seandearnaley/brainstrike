import { createLogger } from '@brainstrike/utils';

const logger = createLogger('CommandSessionInventory');

export type CommandSessionErrorCode =
  | 'aborted'
  | 'cursor-out-of-range'
  | 'cwd-not-found'
  | 'cwd-outside-root'
  | 'internal'
  | 'invalid-input'
  | 'root-unavailable'
  | 'session-exited'
  | 'session-id-collision'
  | 'session-not-found'
  | 'start-failed'
  | 'stop-failed';

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

interface CommandSessionIdentityParams {
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

const REQUIRED_METHODS: readonly (keyof CommandSessionBridge)[] = [
  'list',
  'read',
  'write',
  'stop',
  'remove',
];

export function resolveCommandSessionBridge(): CommandSessionBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const bridge = (window as Window & { commandSessions?: Partial<CommandSessionBridge> })
    .commandSessions;
  if (!bridge) {
    return null;
  }
  const missing = REQUIRED_METHODS.filter((method) => typeof bridge[method] !== 'function');
  if (missing.length > 0) {
    logger.error('window.commandSessions bridge is malformed; inventory disabled', { missing });
    return null;
  }
  return bridge as CommandSessionBridge;
}

export function isCommandSessionBridgeAvailable(): boolean {
  return resolveCommandSessionBridge() !== null;
}
