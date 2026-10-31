/**
 * Structural typing for the command-session bridge (the inventory of
 * long-running command sessions an assistant started in a workspace root).
 *
 * The desktop builds it from its agent-host connection and provides it through
 * `WorkspaceTerminalServicesProvider` (ADR-0029); a tree without a provider has
 * none, and the inventory is omitted, never stubbed.
 */
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';

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
    BoundaryResult<{
      readonly rootId: string;
      readonly sessions: readonly CommandSessionInfo[];
    }>
  >;
  readonly read: (
    params: CommandSessionIdentityParams & { readonly cursor?: number }
  ) => Promise<BoundaryResult<CommandSessionReadPage>>;
  readonly remove: (params: CommandSessionIdentityParams) => Promise<BoundaryResult<null>>;
  readonly stop: (params: CommandSessionIdentityParams) => Promise<BoundaryResult<null>>;
  readonly write: (
    params: CommandSessionIdentityParams & { readonly data: string }
  ) => Promise<BoundaryResult<null>>;
}
