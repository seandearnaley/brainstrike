/**
 * The agent host's `worktrees/*` narrowing boundary. Every renderer-supplied argument is
 * `unknown`; validation failures return a typed `{ ok: false }` `BoundaryResult`,
 * never a thrown error — mirroring `changes-methods.ts`.
 *
 * `resolveService` is LAZY for the same reason `resolveInventoryService` is:
 * this domain is registered at module load while the service is constructed at
 * `app.whenReady()`. Absence is reported as a visible typed failure, never as
 * an empty worktree list — an empty list is a real, different fact.
 */

import path from 'node:path';
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import { createLogger } from '@brainstrike/logging';
import type {
  ManagedWorktreePathEntry,
  ManagedWorktreeRow,
  WorktreeAdoptParams,
  WorktreeArchivePreview,
  WorktreeArchiveResult,
  WorktreeCheckoutStatus,
  WorktreeCreateContext,
  WorktreeCreateParams,
  WorktreeCreateResult,
  WorktreeListEntry,
  WorktreeRepositorySetupDecision,
  WorktreeSettings,
  WorktreeSetupCommand,
  WorktreeSetupConsent,
} from '@brainstrike/types';
import { Predicate } from 'effect';
import { gitInvalid, gitRefused, gitThrew } from './git-failure.ts';
import { newestArchiveFirst } from './worktree-ledger.ts';
import type { WorktreeService } from './worktree-service.ts';
import {
  decideWorktreeSetupConsent,
  listWorktreeSetupConsents,
  revokeWorktreeSetupConsent,
  type WorktreeSetupConsentStore,
} from './worktree-setup-consent.ts';

const logger = createLogger('WorktreesMethods');

export interface WorktreesMethods {
  readonly adopt: (payload: unknown) => Promise<BoundaryResult<ManagedWorktreeRow>>;
  readonly archive: (payload: unknown) => Promise<BoundaryResult<WorktreeArchiveResult>>;
  readonly checkoutStatus: (payload: unknown) => Promise<BoundaryResult<WorktreeCheckoutStatus>>;
  readonly create: (payload: unknown) => Promise<BoundaryResult<WorktreeCreateResult>>;
  readonly createBranchHere: (payload: unknown) => Promise<BoundaryResult<ManagedWorktreeRow>>;
  readonly createContext: (payload: unknown) => Promise<BoundaryResult<WorktreeCreateContext>>;
  /** A person's Allow or Skip for the root's repository setup script, at the hash they saw. */
  readonly decideSetupConsent: (payload: unknown) => Promise<BoundaryResult<WorktreeSetupConsent>>;
  readonly getSettings: () => Promise<BoundaryResult<WorktreeSettings>>;
  readonly inspectArchive: (payload: unknown) => Promise<BoundaryResult<WorktreeArchivePreview>>;
  readonly list: () => Promise<BoundaryResult<readonly WorktreeListEntry[]>>;
  readonly listArchived: (
    payload: unknown
  ) => Promise<BoundaryResult<readonly ManagedWorktreeRow[]>>;
  readonly listManagedPaths: () => Promise<BoundaryResult<readonly ManagedWorktreePathEntry[]>>;
  readonly listSetupConsent: () => Promise<BoundaryResult<readonly WorktreeSetupConsent[]>>;
  readonly restore: (payload: unknown) => Promise<BoundaryResult<WorktreeCreateResult>>;
  readonly revokeSetupConsent: (
    payload: unknown
  ) => Promise<BoundaryResult<{ readonly revoked: boolean }>>;
  readonly setSettings: (payload: unknown) => Promise<BoundaryResult<WorktreeSettings>>;
}

export interface WorktreesMethodsOptions {
  /** A repository's managed worktrees as the ledger records them, archived ones too. */
  readonly listRepositoryWorktrees: (
    repoCommonDir: string
  ) => Promise<readonly ManagedWorktreeRow[]>;
  readonly readSettings: () => Promise<WorktreeSettings>;
  readonly resolveService: () => WorktreeService | null;
  /** The host's state store, which holds the repositories' setup script consent. */
  readonly setupConsentStore: WorktreeSetupConsentStore;
  readonly writeSettings: (next: {
    readonly managedDirectory: string | null;
    readonly setupCommand: WorktreeSetupCommand;
  }) => Promise<WorktreeSettings>;
}

const SERVICE_UNAVAILABLE = 'The worktree service is not available in this session.';

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function validateAdopt(payload: unknown): BoundaryResult<WorktreeAdoptParams> {
  if (
    !(
      Predicate.isObject(payload) &&
      nonEmptyString(payload['path']) &&
      path.isAbsolute(payload['path'] as string)
    ) ||
    (payload['createdBy'] !== 'agent' && payload['createdBy'] !== 'user')
  ) {
    return gitInvalid(
      'worktrees:adopt requires { path: <absolute path>, createdBy: "agent" | "user" }.'
    );
  }
  const id = payload['id'];
  const runId = payload['runId'];
  const threadId = payload['threadId'];
  // An unknown-typed client boundary: a PRESENT runId/threadId that is not a
  // non-empty string is rejected, never silently coerced to absent. Silently
  // dropping a malformed runId would still adopt the worktree, just without
  // the run attribution the caller asked for — a different outcome than the
  // one requested, produced without saying so.
  if (id !== undefined && !nonEmptyString(id)) {
    return gitInvalid('worktrees:adopt id must be a non-empty string when present.');
  }
  if (runId !== undefined && !nonEmptyString(runId)) {
    return gitInvalid('worktrees:adopt runId must be a non-empty string when present.');
  }
  if (threadId !== undefined && !nonEmptyString(threadId)) {
    return gitInvalid('worktrees:adopt threadId must be a non-empty string when present.');
  }
  return {
    ok: true,
    value: {
      createdBy: payload['createdBy'],
      ...(nonEmptyString(id) ? { id } : {}),
      path: payload['path'] as string,
      ...(nonEmptyString(runId) ? { runId } : {}),
      ...(nonEmptyString(threadId) ? { threadId } : {}),
    },
  };
}

function validateCheckoutStatus(payload: unknown): BoundaryResult<{ readonly path: string }> {
  if (
    !(
      Predicate.isObject(payload) &&
      nonEmptyString(payload['path']) &&
      path.isAbsolute(payload['path'])
    )
  ) {
    return gitInvalid('worktrees:checkoutStatus requires { path: <absolute path> }.');
  }
  return { ok: true, value: { path: payload['path'] } };
}

function validateCreate(payload: unknown): BoundaryResult<WorktreeCreateParams> {
  if (
    !(
      Predicate.isObject(payload) &&
      nonEmptyString(payload['rootId']) &&
      nonEmptyString(payload['baseRef']) &&
      nonEmptyString(payload['name'])
    ) ||
    (payload['createdBy'] !== 'agent' && payload['createdBy'] !== 'user')
  ) {
    return gitInvalid('worktrees:create requires { rootId, baseRef, name, branch, createdBy }.');
  }
  const branch = payload['branch'];
  const detached = Predicate.isObject(branch) && branch['detached'] === true;
  const named = Predicate.isObject(branch) && nonEmptyString(branch['name']);
  if (!(detached || named)) {
    return gitInvalid('worktrees:create branch must be { detached: true } or { name: string }.');
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
      // Schema-stability field: forwarded now but intentionally inert until
      // the worktree timeline lands in Task 18.
      ...(nonEmptyString(payload['runId']) ? { runId: payload['runId'] } : {}),
      ...(nonEmptyString(payload['threadId']) ? { threadId: payload['threadId'] } : {}),
    },
  };
}

function validateArchive(payload: unknown): BoundaryResult<{
  readonly confirmIgnoredEntries?: string;
  readonly force?: boolean;
  readonly runId?: string;
  readonly worktreeId: string;
}> {
  if (!(Predicate.isObject(payload) && nonEmptyString(payload['worktreeId']))) {
    return gitInvalid('worktrees:archive requires { worktreeId }.');
  }
  if (payload['force'] !== undefined && typeof payload['force'] !== 'boolean') {
    return gitInvalid('worktrees:archive force must be a boolean when present.');
  }
  if (
    payload['confirmIgnoredEntries'] !== undefined &&
    !nonEmptyString(payload['confirmIgnoredEntries'])
  ) {
    return gitInvalid(
      'worktrees:archive confirmIgnoredEntries must be a non-empty string when present.'
    );
  }
  return {
    ok: true,
    value: {
      worktreeId: payload['worktreeId'],
      ...(nonEmptyString(payload['confirmIgnoredEntries'])
        ? { confirmIgnoredEntries: payload['confirmIgnoredEntries'] }
        : {}),
      ...(typeof payload['force'] === 'boolean' ? { force: payload['force'] } : {}),
      // Schema-stability field: forwarded now but intentionally inert until
      // the worktree timeline lands in Task 18.
      ...(nonEmptyString(payload['runId']) ? { runId: payload['runId'] } : {}),
    },
  };
}

function validateInspectArchive(payload: unknown): BoundaryResult<{ readonly worktreeId: string }> {
  if (!(Predicate.isObject(payload) && nonEmptyString(payload['worktreeId']))) {
    return gitInvalid('worktrees:inspectArchive requires { worktreeId }.');
  }
  return { ok: true, value: { worktreeId: payload['worktreeId'] } };
}

function validateCreateBranchHere(payload: unknown): BoundaryResult<{
  readonly branch: string;
  readonly worktreeId: string;
}> {
  if (
    !(
      Predicate.isObject(payload) &&
      nonEmptyString(payload['branch']) &&
      nonEmptyString(payload['worktreeId'])
    )
  ) {
    return gitInvalid('worktrees:createBranchHere requires { branch, worktreeId }.');
  }
  return { ok: true, value: { branch: payload['branch'], worktreeId: payload['worktreeId'] } };
}

function validateRootRequest(
  channel: string,
  payload: unknown
): BoundaryResult<{ readonly rootId: string }> {
  if (!(Predicate.isObject(payload) && nonEmptyString(payload['rootId']))) {
    return gitInvalid(`${channel} requires { rootId }.`);
  }
  return { ok: true, value: { rootId: payload['rootId'] } };
}

function validateRestore(payload: unknown): BoundaryResult<{
  readonly worktreeId: string;
}> {
  if (!(Predicate.isObject(payload) && nonEmptyString(payload['worktreeId']))) {
    return gitInvalid('worktrees:restore requires { worktreeId }.');
  }
  return { ok: true, value: { worktreeId: payload['worktreeId'] } };
}

function validateDecideSetupConsent(payload: unknown): BoundaryResult<{
  readonly decision: WorktreeRepositorySetupDecision;
  readonly rootId: string;
  readonly scriptSha256: string;
}> {
  if (
    !(
      Predicate.isObject(payload) &&
      nonEmptyString(payload['rootId']) &&
      nonEmptyString(payload['scriptSha256']) &&
      (payload['decision'] === 'approved' || payload['decision'] === 'denied')
    )
  ) {
    return gitInvalid(
      'worktrees:setup-consent/decide requires { rootId, decision: "approved" | "denied", scriptSha256 }.'
    );
  }
  return {
    ok: true,
    value: {
      decision: payload['decision'],
      rootId: payload['rootId'],
      scriptSha256: payload['scriptSha256'],
    },
  };
}

function validateRevokeSetupConsent(
  payload: unknown
): BoundaryResult<{ readonly repositoryId: string }> {
  if (!(Predicate.isObject(payload) && nonEmptyString(payload['repositoryId']))) {
    return gitInvalid('worktrees:setup-consent/revoke requires { repositoryId }.');
  }
  return { ok: true, value: { repositoryId: payload['repositoryId'] } };
}

export function createWorktreesMethods(options: WorktreesMethodsOptions): WorktreesMethods {
  const failed = (channel: string, error: unknown): BoundaryResult<never> => {
    logger.error(`Unexpected ${channel} handler failure`, { error });
    return gitThrew(error);
  };

  async function withService<T>(
    channel: string,
    op: (service: WorktreeService) => Promise<BoundaryResult<T>>
  ): Promise<BoundaryResult<T>> {
    const service = options.resolveService();
    if (!service) {
      return gitRefused('availability', 'worktree.service-unavailable', SERVICE_UNAVAILABLE);
    }
    try {
      return await op(service);
    } catch (error) {
      return failed(channel, error);
    }
  }

  return {
    adopt: async (payload) => {
      const params = validateAdopt(payload);
      if (!params.ok) {
        return params;
      }
      return await withService('worktrees:adopt', (service) => service.adopt(params.value));
    },
    archive: async (payload) => {
      const params = validateArchive(payload);
      if (!params.ok) {
        return params;
      }
      return await withService('worktrees:archive', (service) => service.archive(params.value));
    },
    checkoutStatus: async (payload) => {
      const params = validateCheckoutStatus(payload);
      if (!params.ok) {
        return params;
      }
      return await withService('worktrees:checkoutStatus', (service) =>
        service.checkoutStatus(params.value)
      );
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
      const params = validateRootRequest('worktrees:createContext', payload);
      if (!params.ok) {
        return params;
      }
      return await withService('worktrees:createContext', (service) =>
        service.createContext(params.value)
      );
    },
    // Called only for a person's answer: the create sheet's Allow or Skip.
    decideSetupConsent: async (payload) => {
      const params = validateDecideSetupConsent(payload);
      if (!params.ok) {
        return params;
      }
      const { decision, rootId, scriptSha256 } = params.value;
      return await withService('worktrees:setup-consent/decide', async (service) => {
        const repository = await service.repositoryContextForRoot(rootId);
        if (!repository.ok) {
          return repository;
        }
        return await decideWorktreeSetupConsent(options.setupConsentStore, {
          decision,
          repository: repository.value,
          scriptSha256,
        });
      });
    },
    getSettings: async () => {
      try {
        return { ok: true, value: await options.readSettings() };
      } catch (error) {
        return failed('worktrees:getSettings', error);
      }
    },
    inspectArchive: async (payload) => {
      const params = validateInspectArchive(payload);
      if (!params.ok) {
        return params;
      }
      return await withService('worktrees:inspectArchive', (service) =>
        service.inspectArchive(params.value)
      );
    },
    list: async () => await withService('worktrees:list', (service) => service.list()),
    // ADR-0034 decision 7: the archived worktrees of the repository the root is in, which the
    // where-control's picker offers to restore.
    listArchived: async (payload) => {
      const params = validateRootRequest('worktrees:listArchived', payload);
      if (!params.ok) {
        return params;
      }
      return await withService('worktrees:listArchived', async (service) => {
        const repository = await service.repositoryContextForRoot(params.value.rootId);
        if (!repository.ok) {
          return repository;
        }
        const rows = await options.listRepositoryWorktrees(repository.value.commonDir);
        return { ok: true, value: newestArchiveFirst(rows) };
      });
    },
    listManagedPaths: async () =>
      await withService('worktrees:listManagedPaths', (service) => service.listManagedPaths()),
    listSetupConsent: async () => {
      try {
        return { ok: true, value: await listWorktreeSetupConsents(options.setupConsentStore) };
      } catch (error) {
        return failed('worktrees:setup-consent/list', error);
      }
    },
    restore: async (payload) => {
      const params = validateRestore(payload);
      if (!params.ok) {
        return params;
      }
      return await withService('worktrees:restore', (service) => service.restore(params.value));
    },
    // Called only for a person's answer: Settings › Workspace's Revoke.
    revokeSetupConsent: async (payload) => {
      const params = validateRevokeSetupConsent(payload);
      if (!params.ok) {
        return params;
      }
      try {
        return {
          ok: true,
          value: {
            revoked: await revokeWorktreeSetupConsent(
              options.setupConsentStore,
              params.value.repositoryId
            ),
          },
        };
      } catch (error) {
        return failed('worktrees:setup-consent/revoke', error);
      }
    },
    setSettings: async (payload) => {
      if (!Predicate.isObject(payload)) {
        return gitInvalid('worktrees:setSettings requires an object payload.');
      }
      const managedDirectory = payload['managedDirectory'];
      const setupCommand = payload['setupCommand'];
      if (
        !(
          managedDirectory === null ||
          (nonEmptyString(managedDirectory) && path.isAbsolute(managedDirectory))
        )
      ) {
        return gitInvalid(
          'worktrees:setSettings managedDirectory must be an absolute path or null.'
        );
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
        return gitInvalid(
          'worktrees:setSettings setupCommand must be a non-empty string array, "disabled", or null.'
        );
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
