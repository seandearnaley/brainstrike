import { createLogger } from '@brainstrike/logging';
import {
  COMMAND_SESSION_READ_PAGE_UTF16_CODE_UNITS,
  CommandSessionError,
  type CommandSessionErrorCode,
  type CommandSessionInfo,
  type CommandSessionManager,
  type CommandSessionRead,
} from '../assistant-server/command-session-manager';

const logger = createLogger('HostCommandSessions');

type CommandSessionResult<T = void> =
  | (T extends void ? { readonly ok: true } : { readonly ok: true; readonly value: T })
  | {
      readonly error: {
        readonly code: CommandSessionErrorCode | 'internal';
        readonly message: string;
      };
      readonly ok: false;
    };

interface CommandSessionIdentityParams {
  readonly rootId: string;
  readonly sessionId: string;
}

interface CommandSessionListParams {
  readonly rootId: string;
}

interface CommandSessionReadParams extends CommandSessionIdentityParams {
  readonly cursor?: number;
}

interface CommandSessionWriteParams extends CommandSessionIdentityParams {
  readonly data: string;
}

interface CommandSessionReadPage {
  readonly bufferStartCursor: number;
  readonly hasMore: boolean;
  readonly nextCursor: number;
  readonly output: string;
  readonly requestedCursor: number;
  readonly session: CommandSessionInfo;
  readonly truncatedBeforeCursor: boolean;
}

export interface CommandSessionHandlers {
  readonly list: (params: CommandSessionListParams) => CommandSessionResult<{
    readonly rootId: string;
    readonly sessions: readonly CommandSessionInfo[];
  }>;
  readonly read: (params: CommandSessionReadParams) => CommandSessionResult<CommandSessionReadPage>;
  readonly remove: (params: CommandSessionIdentityParams) => Promise<CommandSessionResult>;
  readonly stop: (params: CommandSessionIdentityParams) => Promise<CommandSessionResult>;
  readonly write: (params: CommandSessionWriteParams) => CommandSessionResult;
}

function success(): CommandSessionResult {
  return { ok: true };
}

function failure(error: unknown): CommandSessionResult<never> {
  if (error instanceof CommandSessionError) {
    return { error: { code: error.code, message: error.message }, ok: false };
  }
  logger.error('Unexpected command-session failure', {
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
    throw new TypeError('Command-session manager returned an oversized page.');
  }
  if (read.hasMore && read.output.length > 0) {
    const finalCodeUnit = read.output.charCodeAt(read.output.length - 1);
    if (finalCodeUnit >= 0xd8_00 && finalCodeUnit <= 0xdb_ff) {
      throw new TypeError('Command-session manager split a surrogate pair across pages.');
    }
  }
}

/** The Terminal panel's inventory of this host's command sessions; a failure is a value, never a throw. */
export function createCommandSessionHandlers(
  manager: CommandSessionManager
): CommandSessionHandlers {
  function list(params: CommandSessionListParams): CommandSessionResult<{
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

  function read(params: CommandSessionReadParams): CommandSessionResult<CommandSessionReadPage> {
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

  function write(params: CommandSessionWriteParams): CommandSessionResult {
    try {
      manager.write(params?.rootId, params?.sessionId, params?.data);
      return success();
    } catch (error) {
      return failure(error);
    }
  }

  async function stop(params: CommandSessionIdentityParams): Promise<CommandSessionResult> {
    try {
      await manager.stop(params?.rootId, params?.sessionId);
      return success();
    } catch (error) {
      return failure(error);
    }
  }

  async function remove(params: CommandSessionIdentityParams): Promise<CommandSessionResult> {
    try {
      await manager.remove(params?.rootId, params?.sessionId);
      return success();
    } catch (error) {
      return failure(error);
    }
  }

  return { list, read, remove, stop, write };
}
