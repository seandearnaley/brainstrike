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
  ForgeRendererRefreshReason,
  ForgeResult,
  GitForgeRepositoryContext,
} from '@brainstrike/types';
import type { ForgeRepositoryResolver, ForgeService } from './assistant-server/forge-service';
import { createGitService, GIT_DEFAULT_TIMEOUT_MS } from './assistant-server/git-service';
import { execFileGitRunner } from './git-ipc-handlers';
import { resolveRootCwd, type WorkspaceRootResolver } from './workspace-root-cwd';

const logger = createLogger('ForgeIpc');

const REFRESH_REASONS = {
  invalidation: true,
  user: true,
  window: true,
} as const satisfies Record<ForgeRendererRefreshReason, true>;

const REFRESH_REASON_KEYS = Object.keys(REFRESH_REASONS) as readonly ForgeRendererRefreshReason[];

/** Type guard so a future renderer refresh reason can't be silently rejected. */
function isForgeRefreshReason(value: string): value is ForgeRendererRefreshReason {
  return Object.hasOwn(REFRESH_REASONS, value);
}

function formatReasonList(reasons: readonly string[]): string {
  const quoted = reasons.map((reason) => `"${reason}"`);
  return quoted.length <= 1
    ? quoted.join('')
    : `${quoted.slice(0, -1).join(', ')} or ${quoted.at(-1)}`;
}

const REFRESH_REASON_ERROR = `forge refresh requires reason ${formatReasonList(REFRESH_REASON_KEYS)}`;

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

function requireReason(params: unknown): ForgeResult<ForgeRendererRefreshReason> {
  const reason =
    typeof params === 'object' && params !== null
      ? (params as { reason?: unknown }).reason
      : undefined;
  if (typeof reason !== 'string' || !isForgeRefreshReason(reason)) {
    return {
      error: REFRESH_REASON_ERROR,
      ok: false,
    };
  }
  return { ok: true, value: reason };
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

/** A resolved `{ cwd, context }` pair, cached per `rootId` (see below). */
interface ForgeRepositoryResolution {
  readonly context: GitForgeRepositoryContext;
  readonly cwd: string;
}

/**
 * A {@link ForgeRepositoryResolver} that also exposes cache invalidation.
 * Deliberately NOT folded into `ForgeRepositoryResolver` itself — that type
 * is the `ForgeService`'s bridge-facing dependency shape, and widening it
 * would leak this resolver's caching implementation detail into every other
 * (real or test) implementation of the interface.
 */
export interface ForgeRepositoryResolverWithCache extends ForgeRepositoryResolver {
  /** Drop every cached resolution whose `commonDir` matches. */
  readonly invalidateResolverCache: (gitCommonDir: string) => void;
}

/**
 * Resolve a durable `rootId` to `{ cwd, context }` for the ForgeService.
 *
 * The cwd is the realpath'd, containment-checked workspace root; the context
 * comes from ONE `createGitService` call against it, so the repository
 * identity the PR cache keys on is the same realpath'd common dir the git
 * inventory and the Changes surface use.
 *
 * `forgeRepositoryContext()` is 5 sequential `git` spawns plus a `realpath`,
 * and this resolver re-runs from scratch on every `identity`/`prStatus`/
 * `refresh` call unless cached — a chip mounting typically calls `identity`
 * then `prStatus`, paying all of it twice for facts (branch, remote) that
 * only change when the git-metadata watcher says so. Caching per `rootId`,
 * invalidated by the SAME `gitCommonDir` signal the watcher already emits
 * (wired in `main.ts`'s `onInvalidate`), cuts steady-state cost to zero
 * without changing any observable behavior.
 */
export function createForgeRepositoryResolver(
  resolver: WorkspaceRootResolver
): ForgeRepositoryResolverWithCache {
  const cache = new Map<string, ForgeRepositoryResolution>();

  const resolve: ForgeRepositoryResolver = async (rootId) => {
    const cached = cache.get(rootId);
    if (cached) {
      return { ok: true, value: cached };
    }
    const cwd = await resolveRootCwd(resolver, rootId, 'forge', logger);
    if (!cwd.ok) {
      return { error: cwd.error, ok: false };
    }
    const git = createGitService({
      cwd: cwd.value,
      run: execFileGitRunner,
      // Bounds the whole resolution (5 spawns + a realpath) to ONE
      // GIT_DEFAULT_TIMEOUT_MS deadline instead of each spawn independently
      // being able to hold up to that long with no way to cancel it.
      signal: AbortSignal.timeout(GIT_DEFAULT_TIMEOUT_MS),
    });
    const context = await git.forgeRepositoryContext();
    if (!context.ok) {
      return { error: context.error, ok: false };
    }
    const resolution: ForgeRepositoryResolution = { context: context.value, cwd: cwd.value };
    cache.set(rootId, resolution);
    return { ok: true, value: resolution };
  };

  function invalidateResolverCache(gitCommonDir: string): void {
    for (const [rootId, resolution] of cache) {
      if (resolution.context.commonDir === gitCommonDir) {
        cache.delete(rootId);
      }
    }
  }

  return Object.assign(resolve, { invalidateResolverCache });
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
