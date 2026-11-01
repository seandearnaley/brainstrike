import { randomUUID } from 'node:crypto';
import {
  type BoundaryFailureCategory,
  fault,
  refusal,
} from '@brainstrike/assistant-contract/boundary-failure';
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import { createLogger } from '@brainstrike/logging';
import {
  COMMAND_SESSION_READ_PAGE_UTF16_CODE_UNITS,
  CommandSessionError,
  type CommandSessionErrorCode,
  type CommandSessionInfo,
  type CommandSessionManager,
  type CommandSessionRead,
} from './command-session-manager.ts';

const logger = createLogger('HostCommandSessions');

type CommandSessionResult<T = null> = BoundaryResult<T>;

/** How each manager refusal reads at the boundary; the rest are faults whose cause stays here. */
const REFUSAL_CATEGORIES: Partial<Record<CommandSessionErrorCode, BoundaryFailureCategory>> = {
  aborted: 'availability',
  'cursor-out-of-range': 'input',
  'cwd-not-found': 'input',
  'cwd-outside-root': 'input',
  'invalid-input': 'input',
  'root-unavailable': 'availability',
  'session-exited': 'conflict',
  'session-not-found': 'input',
  'workspace-busy': 'conflict',
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
  return { ok: true, value: null };
}

function failure(error: unknown): CommandSessionResult<never> {
  const category =
    error instanceof CommandSessionError ? REFUSAL_CATEGORIES[error.code] : undefined;
  if (error instanceof CommandSessionError && category !== undefined) {
    return {
      error: refusal({ category, code: `command-session.${error.code}`, message: error.message }),
      ok: false,
    };
  }
  const correlationId = randomUUID();
  logger.error('Command-session call failed', {
    code: error instanceof CommandSessionError ? error.code : undefined,
    correlationId,
    error: error instanceof Error ? error.message : String(error),
    errorName: error instanceof Error ? error.name : 'UnknownError',
  });
  return {
    error: fault({
      category: 'internal',
      code:
        error instanceof CommandSessionError
          ? `command-session.${error.code}`
          : 'command-session.internal',
      correlationId,
      message: 'The command session failed unexpectedly.',
    }),
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
