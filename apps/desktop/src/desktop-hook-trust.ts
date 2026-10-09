import { isAbsolute, resolve } from 'node:path';
import { hostHookApprovalFor } from '@brainstrike/agent-host';
import type { HostMethod, HostParams, HostResults } from '@brainstrike/agent-host/protocol';
import type { WorkspaceRootsQueryable } from '@brainstrike/assistant-service/node-workspace-services';
import { createLogger } from '@brainstrike/logging';
import { ErrorCodes, ResponseError } from 'vscode-jsonrpc';
import { z } from 'zod';

const logger = createLogger('DesktopHookTrust');

/** The retired renderer hook-trust store's persisted slice in Main's storage. */
export const LEGACY_HOOK_TRUST_STORAGE_KEY = 'hook-trust.v1';
/** The slice version keyed by DB `roots.id`; older slices were dropped unread. */
const LEGACY_DB_KEYED_VERSION = 2;

const LegacySliceSchema = z.object({
  state: z.object({ approvalsByRootId: z.record(z.string(), z.unknown()) }),
  version: z.number(),
});
const LegacyApprovalSchema = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/) });

type HostRequest = <M extends HostMethod>(
  method: M,
  params: HostParams<M>
) => Promise<HostResults[M]>;

export interface DesktopHookTrustOptions {
  /** Every DB root's path by `roots.id`, live or disconnected. */
  readonly loadRootPaths: () => Promise<ReadonlyMap<string, string>>;
  /** Main's own client of the host this app launched. */
  readonly request: HostRequest;
  readonly storage: {
    getItem(key: string): Promise<string | null>;
    removeItem(key: string): Promise<void>;
  };
}

/** Main's view of the host-owned hook trust; every call first joins the one-time import. */
export interface DesktopHookTrust {
  /** The hash a root's project hooks may run at: the host's trust at this same path. */
  approval(root: {
    readonly absPath: string;
    readonly rootId: string;
  }): Promise<string | undefined>;
  /**
   * Imports the renderer's earlier approvals into the host once. Each is
   * re-hashed by the host, so only an exact match becomes trusted; the slice
   * is removed after every entry settled, and a failed import runs again.
   */
  imported(): Promise<void>;
  trust(params: HostParams<'hooks/trust'>): Promise<void>;
  untrust(rootId: string): Promise<void>;
}

/** Every DB root's path, resolved as admission resolves a live root's path. */
export async function loadDesktopRootPaths(
  db: WorkspaceRootsQueryable
): Promise<ReadonlyMap<string, string>> {
  const { rows } = await db.query<{ id: string; path: string }>(
    `SELECT id, path FROM roots WHERE path IS NOT NULL AND path <> ''`
  );
  const paths = new Map<string, string>();
  for (const row of rows) {
    const path = row.path.trim();
    if (isAbsolute(path)) {
      paths.set(row.id, resolve(path));
    }
  }
  return paths;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return;
  }
}

function legacyApprovals(raw: string): Array<{ rootId: string; sha256: string }> {
  const slice = LegacySliceSchema.safeParse(parseJson(raw));
  if (!slice.success) {
    // The retired store's own merge read such a slice as no approvals.
    logger.warn('The retired hook-trust slice is unreadable; nothing to import', {
      error: slice.error.message,
    });
    return [];
  }
  if (slice.data.version < LEGACY_DB_KEYED_VERSION) {
    return [];
  }
  return Object.entries(slice.data.state.approvalsByRootId).flatMap(([rootId, record]) => {
    const approval = LegacyApprovalSchema.safeParse(record);
    if (approval.success) {
      return [{ rootId, sha256: approval.data.sha256 }];
    }
    logger.warn('A retired hook approval is malformed; it stays untrusted', { rootId });
    return [];
  });
}

export function createDesktopHookTrust(options: DesktopHookTrustOptions): DesktopHookTrust {
  const { loadRootPaths, request, storage } = options;
  const importOnce = async (): Promise<void> => {
    const raw = await storage.getItem(LEGACY_HOOK_TRUST_STORAGE_KEY);
    if (raw === null) {
      return;
    }
    const approvals = legacyApprovals(raw);
    const paths = approvals.length > 0 ? await loadRootPaths() : new Map<string, string>();
    for (const { rootId, sha256 } of approvals) {
      const path = paths.get(rootId);
      if (path === undefined) {
        logger.warn('A retired hook approval names no workspace root; it stays untrusted', {
          rootId,
        });
        continue;
      }
      try {
        await request('hooks/trust', { path, rootId, sha256 });
      } catch (cause) {
        // The host refused what is on disk now: settled, and untrusted until reviewed.
        if (!(cause instanceof ResponseError && cause.code === ErrorCodes.InvalidParams)) {
          throw new Error('Earlier hook approvals could not be imported into the agent host', {
            cause,
          });
        }
        logger.warn('A retired hook approval no longer matches its file; it stays untrusted', {
          reason: cause.message,
          rootId,
        });
      }
    }
    await storage.removeItem(LEGACY_HOOK_TRUST_STORAGE_KEY);
  };
  let importing: Promise<void> | undefined;
  const imported = (): Promise<void> => {
    if (!importing) {
      const attempt = importOnce();
      importing = attempt;
      attempt.catch(() => {
        if (importing === attempt) {
          importing = undefined;
        }
      });
    }
    return importing;
  };
  return {
    approval: async ({ absPath, rootId }) => {
      await imported();
      const { trust } = await request('hooks/trust/read', { rootId });
      return hostHookApprovalFor(trust, absPath);
    },
    imported,
    trust: async (params) => {
      await imported();
      await request('hooks/trust', params);
    },
    untrust: async (rootId) => {
      await imported();
      await request('hooks/untrust', { rootId });
    },
  };
}
