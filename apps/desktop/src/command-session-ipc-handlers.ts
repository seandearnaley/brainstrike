import { createLogger } from '@brainstrike/logging';
import type { HostCommandSessionClient } from './agent-host-platform/host-command-session-client';
import {
  COMMAND_SESSION_READ_PAGE_UTF16_CODE_UNITS,
  CommandSessionError,
  type CommandSessionErrorCode,
  type CommandSessionInfo,
  type CommandSessionManager,
  type CommandSessionRead,
  getDesktopCommandSessionManager,
} from './assistant-server/command-session-manager';

const logger = createLogger('CommandSessionIpc');

export type CommandSessionIpcResult<T = void> =
  | (T extends void ? { readonly ok: true } : { readonly ok: true; readonly value: T })
  | {
      readonly error: {
        readonly code: CommandSessionErrorCode | 'internal';
        readonly message: string;
      };
      readonly ok: false;
    };

export interface CommandSessionIdentityParams {
  readonly rootId: string;
  readonly sessionId: string;
}

export interface CommandSessionListParams {
  readonly rootId: string;
}

export interface CommandSessionReadParams extends CommandSessionIdentityParams {
  readonly cursor?: number;
}

export interface CommandSessionWriteParams extends CommandSessionIdentityParams {
  readonly data: string;
}

export interface CommandSessionReadPage {
  readonly bufferStartCursor: number;
  readonly hasMore: boolean;
  readonly nextCursor: number;
  readonly output: string;
  readonly requestedCursor: number;
  readonly session: CommandSessionInfo;
  readonly truncatedBeforeCursor: boolean;
}

export interface CommandSessionIpcHandlers {
  readonly list: (params: CommandSessionListParams) => CommandSessionIpcResult<{
    readonly rootId: string;
    readonly sessions: readonly CommandSessionInfo[];
  }>;
  readonly read: (
    params: CommandSessionReadParams
  ) => CommandSessionIpcResult<CommandSessionReadPage>;
  readonly remove: (params: CommandSessionIdentityParams) => Promise<CommandSessionIpcResult>;
  readonly stop: (params: CommandSessionIdentityParams) => Promise<CommandSessionIpcResult>;
  readonly write: (params: CommandSessionWriteParams) => CommandSessionIpcResult;
}

interface CommandSessionIpcHandlersOptions {
  readonly manager?: CommandSessionManager;
}

function success(): CommandSessionIpcResult {
  return { ok: true };
}

function failure(error: unknown): CommandSessionIpcResult<never> {
  if (error instanceof CommandSessionError) {
    return { error: { code: error.code, message: error.message }, ok: false };
  }
  logger.error('Unexpected command-session IPC failure', {
    errorName: error instanceof Error ? error.name : 'UnknownError',
  });
  return {
    error: {
      code: 'internal',
      message: error instanceof Error ? error.message : 'Unknown command-session failure.',
    },
    ok: false,
  };
}

function assertBoundedReadPage(read: CommandSessionRead): void {
  if (read.output.length > COMMAND_SESSION_READ_PAGE_UTF16_CODE_UNITS) {
    throw new TypeError('Command-session manager returned an oversized IPC page.');
  }
  if (read.hasMore && read.output.length > 0) {
    const finalCodeUnit = read.output.charCodeAt(read.output.length - 1);
    if (finalCodeUnit >= 0xd8_00 && finalCodeUnit <= 0xdb_ff) {
      throw new TypeError('Command-session manager split a surrogate pair across IPC pages.');
    }
  }
}

export function createCommandSessionIpcHandlers({
  manager = getDesktopCommandSessionManager(),
}: CommandSessionIpcHandlersOptions = {}): CommandSessionIpcHandlers {
  function list(params: CommandSessionListParams): CommandSessionIpcResult<{
    readonly rootId: string;
    readonly sessions: readonly CommandSessionInfo[];
  }> {
    try {
      return {
        ok: true,
        value: { rootId: params?.rootId, sessions: manager.list(params?.rootId) },
      };
    } catch (error) {
      return failure(error);
    }
  }

  function read(params: CommandSessionReadParams): CommandSessionIpcResult<CommandSessionReadPage> {
    try {
      const readResult = manager.read(
        params?.rootId,
        params?.sessionId,
        params?.cursor,
        COMMAND_SESSION_READ_PAGE_UTF16_CODE_UNITS
      );
      assertBoundedReadPage(readResult);
      return {
        ok: true,
        value: {
          ...readResult,
          session: manager.get(params.rootId, params.sessionId),
        },
      };
    } catch (error) {
      return failure(error);
    }
  }

  function write(params: CommandSessionWriteParams): CommandSessionIpcResult {
    try {
      manager.write(params?.rootId, params?.sessionId, params?.data);
      return success();
    } catch (error) {
      return failure(error);
    }
  }

  async function stop(params: CommandSessionIdentityParams): Promise<CommandSessionIpcResult> {
    try {
      await manager.stop(params?.rootId, params?.sessionId);
      return success();
    } catch (error) {
      return failure(error);
    }
  }

  async function remove(params: CommandSessionIdentityParams): Promise<CommandSessionIpcResult> {
    try {
      await manager.remove(params?.rootId, params?.sessionId);
      return success();
    } catch (error) {
      return failure(error);
    }
  }

  return { list, read, remove, stop, write };
}

/** The Terminal panel's inventory: every handler answers asynchronously. */
export interface CommandSessionInventoryHandlers {
  readonly list: (params: CommandSessionListParams) => Promise<
    CommandSessionIpcResult<{
      readonly rootId: string;
      readonly sessions: readonly CommandSessionInfo[];
    }>
  >;
  readonly read: (
    params: CommandSessionReadParams
  ) => Promise<CommandSessionIpcResult<CommandSessionReadPage>>;
  readonly remove: (params: CommandSessionIdentityParams) => Promise<CommandSessionIpcResult>;
  readonly stop: (params: CommandSessionIdentityParams) => Promise<CommandSessionIpcResult>;
  readonly write: (params: CommandSessionWriteParams) => Promise<CommandSessionIpcResult>;
}

function isSessionNotFound(result: { readonly ok: boolean }): boolean {
  return (
    !result.ok &&
    'error' in result &&
    (result.error as { readonly code: string }).code === 'session-not-found'
  );
}

/**
 * Main's legacy sessions beside the connected agent host's. Session ids are
 * UUIDs, so a session Main does not hold belongs to the host, and a request
 * for it goes there; without a connected host there are no host sessions.
 */
export function withHostCommandSessions(
  main: CommandSessionIpcHandlers,
  host: () => HostCommandSessionClient | undefined
): CommandSessionInventoryHandlers {
  async function routed<R extends { readonly ok: boolean }>(
    local: R | Promise<R>,
    forward: (client: HostCommandSessionClient) => Promise<R>
  ): Promise<R> {
    const result = await local;
    const client = host();
    return client && isSessionNotFound(result) ? await forward(client) : result;
  }
  return {
    list: async (params) => {
      const local = main.list(params);
      const client = host();
      if (!(local.ok && client)) {
        return local;
      }
      const remote = await client.list(params);
      if (!remote.ok) {
        return remote;
      }
      return {
        ok: true,
        value: {
          rootId: local.value.rootId,
          sessions: [...local.value.sessions, ...remote.value.sessions],
        },
      };
    },
    read: (params) => routed(main.read(params), (client) => client.read(params)),
    remove: (params) => routed(main.remove(params), (client) => client.remove(params)),
    stop: (params) => routed(main.stop(params), (client) => client.stop(params)),
    write: (params) => routed(main.write(params), (client) => client.write(params)),
  };
}
