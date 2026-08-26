/**
 * The `worktrees` IPC narrowing boundary. Every renderer-supplied argument is
 * `unknown`; validation failures return a typed `{ ok: false }` `GitResult`,
 * never a thrown error — mirroring `changes-ipc-handlers.ts`.
 *
 * `resolveService` is LAZY for the same reason `resolveInventoryService` is:
 * this domain is registered at module load while the service is constructed at
 * `app.whenReady()`. Absence is reported as a visible typed failure, never as
 * an empty worktree list — an empty list is a real, different fact.
 */
import path from 'node:path';
import { createLogger } from '@brainstrike/logging';
import type {
  GitResult,
  ManagedWorktreePathEntry,
  ManagedWorktreeRow,
  WorktreeArchiveResult,
  WorktreeCreateContext,
  WorktreeCreateParams,
  WorktreeCreateResult,
  WorktreeListEntry,
  WorktreeSettings,
  WorktreeSetupCommand,
} from '@brainstrike/types';
import type { WorktreeService } from './assistant-server/worktree-service';

const logger = createLogger('WorktreesIpc');

export interface WorktreesIpcHandlers {
  readonly archive: (payload: unknown) => Promise<GitResult<WorktreeArchiveResult>>;
  readonly create: (payload: unknown) => Promise<GitResult<WorktreeCreateResult>>;
  readonly createBranchHere: (payload: unknown) => Promise<GitResult<ManagedWorktreeRow>>;
  readonly createContext: (payload: unknown) => Promise<GitResult<WorktreeCreateContext>>;
  readonly getSettings: () => Promise<GitResult<WorktreeSettings>>;
  readonly list: () => Promise<GitResult<readonly WorktreeListEntry[]>>;
  readonly listManagedPaths: () => Promise<GitResult<readonly ManagedWorktreePathEntry[]>>;
  readonly restore: (payload: unknown) => Promise<GitResult<WorktreeCreateResult>>;
  readonly setSettings: (payload: unknown) => Promise<GitResult<WorktreeSettings>>;
}

export interface WorktreesIpcHandlersOptions {
  readonly readSettings: () => Promise<WorktreeSettings>;
  readonly resolveService: () => WorktreeService | null;
  readonly writeSettings: (next: {
    readonly managedDirectory: string | null;
    readonly setupCommand: WorktreeSetupCommand;
  }) => Promise<WorktreeSettings>;
}

const SERVICE_UNAVAILABLE = 'The worktree service is not available in this session.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function validateCreate(payload: unknown): GitResult<WorktreeCreateParams> {
  if (
    !(
      isRecord(payload) &&
      nonEmptyString(payload['rootId']) &&
      nonEmptyString(payload['baseRef']) &&
      nonEmptyString(payload['name'])
    ) ||
    (payload['createdBy'] !== 'agent' && payload['createdBy'] !== 'user')
  ) {
    return {
      error: 'worktrees:create requires { rootId, baseRef, name, branch, createdBy }.',
      ok: false,
    };
  }
  const branch = payload['branch'];
  const detached = isRecord(branch) && branch['detached'] === true;
  const named = isRecord(branch) && nonEmptyString(branch['name']);
  if (!(detached || named)) {
    return {
      error: 'worktrees:create branch must be { detached: true } or { name: string }.',
      ok: false,
    };
  }
  const repositorySetupDecision = payload['repositorySetupDecision'];
  if (
    repositorySetupDecision !== undefined &&
    !(
      isRecord(repositorySetupDecision) &&
      nonEmptyString(repositorySetupDecision['repositoryId']) &&
      (repositorySetupDecision['decision'] === 'approved' ||
        repositorySetupDecision['decision'] === 'denied')
    )
  ) {
    return {
      error:
        'worktrees:create repositorySetupDecision must identify a repository and be approved or denied.',
      ok: false,
    };
  }
  return {
    ok: true,
    value: {
      baseRef: payload['baseRef'],
      branch: detached
        ? { detached: true }
        : { name: (branch as Record<string, unknown>)['name'] as string },
      createdBy: payload['createdBy'],
      name: payload['name'],
      rootId: payload['rootId'],
      ...(isRecord(repositorySetupDecision)
        ? {
            repositorySetupDecision: {
              decision: repositorySetupDecision['decision'] as 'approved' | 'denied',
              repositoryId: repositorySetupDecision['repositoryId'] as string,
            },
          }
        : {}),
      // Schema-stability field: forwarded now but intentionally inert until
      // the worktree timeline lands in Task 18.
      ...(nonEmptyString(payload['runId']) ? { runId: payload['runId'] } : {}),
      ...(nonEmptyString(payload['threadId']) ? { threadId: payload['threadId'] } : {}),
    },
  };
}

function validateArchive(payload: unknown): GitResult<{
  readonly force?: boolean;
  readonly runId?: string;
  readonly worktreeId: string;
}> {
  if (!(isRecord(payload) && nonEmptyString(payload['worktreeId']))) {
    return { error: 'worktrees:archive requires { worktreeId }.', ok: false };
  }
  if (payload['force'] !== undefined && typeof payload['force'] !== 'boolean') {
    return { error: 'worktrees:archive force must be a boolean when present.', ok: false };
  }
  return {
    ok: true,
    value: {
      worktreeId: payload['worktreeId'],
      ...(typeof payload['force'] === 'boolean' ? { force: payload['force'] } : {}),
      // Schema-stability field: forwarded now but intentionally inert until
      // the worktree timeline lands in Task 18.
      ...(nonEmptyString(payload['runId']) ? { runId: payload['runId'] } : {}),
    },
  };
}

function validateCreateBranchHere(payload: unknown): GitResult<{
  readonly branch: string;
  readonly worktreeId: string;
}> {
  if (
    !(
      isRecord(payload) &&
      nonEmptyString(payload['branch']) &&
      nonEmptyString(payload['worktreeId'])
    )
  ) {
    return { error: 'worktrees:createBranchHere requires { branch, worktreeId }.', ok: false };
  }
  return { ok: true, value: { branch: payload['branch'], worktreeId: payload['worktreeId'] } };
}

function validateCreateContext(payload: unknown): GitResult<{
  readonly rootId: string;
}> {
  if (!(isRecord(payload) && nonEmptyString(payload['rootId']))) {
    return { error: 'worktrees:createContext requires { rootId }.', ok: false };
  }
  return { ok: true, value: { rootId: payload['rootId'] } };
}

function validateRestore(payload: unknown): GitResult<{
  readonly worktreeId: string;
}> {
  if (!(isRecord(payload) && nonEmptyString(payload['worktreeId']))) {
    return { error: 'worktrees:restore requires { worktreeId }.', ok: false };
  }
  return { ok: true, value: { worktreeId: payload['worktreeId'] } };
}

export function createWorktreesIpcHandlers(
  options: WorktreesIpcHandlersOptions
): WorktreesIpcHandlers {
  const failed = (channel: string, error: unknown): GitResult<never> => {
    logger.error(`Unexpected ${channel} handler failure`, { error });
    return { error: error instanceof Error ? error.message : String(error), ok: false };
  };

  async function withService<T>(
    channel: string,
    op: (service: WorktreeService) => Promise<GitResult<T>>
  ): Promise<GitResult<T>> {
    const service = options.resolveService();
    if (!service) {
      return { error: SERVICE_UNAVAILABLE, ok: false };
    }
    try {
      return await op(service);
    } catch (error) {
      return failed(channel, error);
    }
  }

  return {
    archive: async (payload) => {
      const params = validateArchive(payload);
      if (!params.ok) {
        return params;
      }
      return await withService('worktrees:archive', (service) => service.archive(params.value));
    },
    create: async (payload) => {
      const params = validateCreate(payload);
      if (!params.ok) {
        return params;
      }
      return await withService('worktrees:create', (service) => service.create(params.value));
    },
    createBranchHere: async (payload) => {
      const params = validateCreateBranchHere(payload);
      if (!params.ok) {
        return params;
      }
      return await withService('worktrees:createBranchHere', (service) =>
        service.createBranchHere(params.value)
      );
    },
    createContext: async (payload) => {
      const params = validateCreateContext(payload);
      if (!params.ok) {
        return params;
      }
      return await withService('worktrees:createContext', (service) =>
        service.createContext(params.value)
      );
    },
    getSettings: async () => {
      try {
        return { ok: true, value: await options.readSettings() };
      } catch (error) {
        return failed('worktrees:getSettings', error);
      }
    },
    list: async () => await withService('worktrees:list', (service) => service.list()),
    listManagedPaths: async () =>
      await withService('worktrees:listManagedPaths', (service) => service.listManagedPaths()),
    restore: async (payload) => {
      const params = validateRestore(payload);
      if (!params.ok) {
        return params;
      }
      return await withService('worktrees:restore', (service) => service.restore(params.value));
    },
    setSettings: async (payload) => {
      if (!isRecord(payload)) {
        return { error: 'worktrees:setSettings requires an object payload.', ok: false };
      }
      const managedDirectory = payload['managedDirectory'];
      const setupCommand = payload['setupCommand'];
      if (
        !(
          managedDirectory === null ||
          (nonEmptyString(managedDirectory) && path.isAbsolute(managedDirectory))
        )
      ) {
        return {
          error: 'worktrees:setSettings managedDirectory must be an absolute path or null.',
          ok: false,
        };
      }
      if (
        !(
          setupCommand === null ||
          setupCommand === 'disabled' ||
          (Array.isArray(setupCommand) &&
            setupCommand.length > 0 &&
            setupCommand.every((part) => nonEmptyString(part)))
        )
      ) {
        return {
          error:
            'worktrees:setSettings setupCommand must be a non-empty string array, "disabled", or null.',
          ok: false,
        };
      }
      try {
        return {
          ok: true,
          value: await options.writeSettings({
            managedDirectory: managedDirectory as string | null,
            setupCommand: setupCommand as WorktreeSetupCommand,
          }),
        };
      } catch (error) {
        return failed('worktrees:setSettings', error);
      }
    },
  };
}
