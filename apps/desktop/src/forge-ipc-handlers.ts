/**
 * Handlers for the desktop `forge` IPC domain.
 *
 * Every channel takes a renderer-supplied `rootId` as `unknown`, narrows it,
 * and resolves it through `resolveRootCwd` — the SAME containment check the
 * git and terminal domains use — before any `gh` process is created. There is
 * no path from a renderer string to a spawn cwd that skips it.
 *
 * Every handler resolves a structured `ForgeResult` and never rejects, so a
 * forge failure is rendered by the chip instead of surfacing as an unhandled
 * IPC rejection.
 */
import { createLogger } from '@brainstrike/logging';
import type {
  ForgeIdentityState,
  ForgePrStatus,
  ForgeRefreshReason,
  ForgeResult,
} from '@brainstrike/types';
import type { ForgeRepositoryResolver, ForgeService } from './assistant-server/forge-service';
import { createGitService } from './assistant-server/git-service';
import { execFileGitRunner } from './git-ipc-handlers';
import { resolveRootCwd, type WorkspaceRootResolver } from './workspace-root-cwd';

const logger = createLogger('ForgeIpc');

const REFRESH_REASONS: ReadonlySet<string> = new Set(['invalidation', 'user', 'window']);

export interface ForgeIpcHandlers {
  readonly identity: (rootId: unknown) => Promise<ForgeResult<ForgeIdentityState>>;
  readonly prStatus: (rootId: unknown) => Promise<ForgeResult<ForgePrStatus>>;
  readonly refresh: (rootId: unknown, params: unknown) => Promise<ForgeResult<ForgePrStatus>>;
}

function requireRootId(rootId: unknown): ForgeResult<string> {
  if (typeof rootId !== 'string' || rootId.trim().length === 0) {
    return { error: 'forge requires a non-empty rootId string', ok: false };
  }
  return { ok: true, value: rootId.trim() };
}

function requireReason(params: unknown): ForgeResult<ForgeRefreshReason> {
  const reason =
    typeof params === 'object' && params !== null
      ? (params as { reason?: unknown }).reason
      : undefined;
  if (typeof reason !== 'string' || !REFRESH_REASONS.has(reason)) {
    return {
      error: 'forge refresh requires reason "invalidation", "user" or "window"',
      ok: false,
    };
  }
  return { ok: true, value: reason as ForgeRefreshReason };
}

async function guard<T>(operation: () => Promise<ForgeResult<T>>): Promise<ForgeResult<T>> {
  try {
    return await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Forge IPC handler threw', { error: message });
    return { error: message, ok: false };
  }
}

/**
 * Resolve a durable `rootId` to `{ cwd, context }` for the ForgeService.
 *
 * The cwd is the realpath'd, containment-checked workspace root; the context
 * comes from ONE `createGitService` call against it, so the repository
 * identity the PR cache keys on is the same realpath'd common dir the git
 * inventory and the Changes surface use.
 */
export function createForgeRepositoryResolver(
  resolver: WorkspaceRootResolver
): ForgeRepositoryResolver {
  return async (rootId) => {
    const cwd = await resolveRootCwd(resolver, rootId, 'forge', logger);
    if (!cwd.ok) {
      return { error: cwd.error, ok: false };
    }
    const git = createGitService({ cwd: cwd.value, run: execFileGitRunner });
    const context = await git.forgeRepositoryContext();
    if (!context.ok) {
      return { error: context.error, ok: false };
    }
    return { ok: true, value: { context: context.value, cwd: cwd.value } };
  };
}

export function createForgeIpcHandlers(options: {
  readonly service: ForgeService;
}): ForgeIpcHandlers {
  const { service } = options;
  return {
    identity: (rootId) =>
      guard(async () => {
        const id = requireRootId(rootId);
        return id.ok ? await service.identity(id.value) : id;
      }),
    prStatus: (rootId) =>
      guard(async () => {
        const id = requireRootId(rootId);
        return id.ok ? await service.prStatus(id.value) : id;
      }),
    refresh: (rootId, params) =>
      guard(async () => {
        const id = requireRootId(rootId);
        if (!id.ok) {
          return id;
        }
        const reason = requireReason(params);
        return reason.ok ? await service.refresh(id.value, reason.value) : reason;
      }),
  };
}
