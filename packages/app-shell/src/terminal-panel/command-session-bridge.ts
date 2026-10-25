/**
 * Structural typing for the command-session bridge (the inventory of
 * long-running command sessions an assistant started in a workspace root).
 *
 * The desktop builds it from its agent-host connection and provides it through
 * `WorkspaceTerminalServicesProvider` (ADR-0029); a tree without a provider has
 * none, and the inventory is omitted, never stubbed.
 */

type CommandSessionErrorCode =
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
