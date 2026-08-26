/**
 * The two worktree agent tools (BST-1392, spec §6.4).
 *
 * They call the SAME `WorktreeService` the Mode chip calls — there is exactly
 * one worktree code path, and neither tool shells out to `git worktree`. The
 * capability object closes over the request's `runId`, `threadId` and
 * `createdBy: 'agent'`, so the ledger's provenance columns are filled by
 * construction rather than by a model-supplied field the model could lie about.
 *
 * Absence of the capability THROWS with a stated reason. Returning an empty
 * list would present "the service is not wired" as the different, honest fact
 * "this workspace has no worktrees".
 */

import type { ListWorktreesInput, ManageWorktreeInput, RuntimeData } from '@brainstrike/agent';
import { NATIVE_TOOL_INPUT_SCHEMAS, normalizeManageWorktreeInput } from '@brainstrike/agent';
import { NATIVE_TOOL_ID, TOOL_DESCRIPTIONS } from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import type {
  GitResult,
  WorktreeArchiveResult,
  WorktreeCreateResult,
  WorktreeListEntry,
} from '@brainstrike/types';
import { parseToolExecuteInput, type ToolExecuteInput } from './tool-execute-support';
import { resolveWorkspaceRoot } from './workspace-roots';

const logger = createLogger('WorktreeTools');

const UNAVAILABLE = 'Worktree management is not available in this session.';

export interface WorktreeToolCapability {
  readonly archive: (params: {
    readonly force?: boolean;
    readonly worktreeId: string;
  }) => Promise<GitResult<WorktreeArchiveResult>>;
  readonly create: (params: {
    readonly baseRef: string;
    readonly branch: string;
    readonly name: string;
    readonly rootId: string;
  }) => Promise<GitResult<WorktreeCreateResult>>;
  readonly list: () => Promise<GitResult<readonly WorktreeListEntry[]>>;
}

export interface ListedWorktree {
  readonly branch: string | null;
  readonly detached: boolean;
  readonly disabledReason: string | null;
  readonly externalTool: string | null;
  readonly managed: boolean;
  readonly name: string;
  readonly path: string;
  readonly primary: boolean;
  readonly provenance: string;
  readonly repositoryRoot: string;
  readonly usable: boolean;
  readonly worktreeId: string | null;
}

export interface ListWorktreesToolResult {
  readonly worktrees: readonly ListedWorktree[];
}

export type ManageWorktreeToolResult =
  | {
      readonly action: 'archive';
      readonly snapshotRef: string;
      readonly worktreeId: string;
    }
  | {
      readonly action: 'create';
      readonly branch: string | null;
      readonly path: string;
      readonly setupReason: string | null;
      readonly setupStatus: string;
      readonly worktreeId: string;
    };

function requireCapability(capability: WorktreeToolCapability | undefined): WorktreeToolCapability {
  if (!capability) {
    throw new Error(UNAVAILABLE);
  }
  return capability;
}

function project(entry: WorktreeListEntry): ListedWorktree {
  return {
    branch: entry.branch,
    detached: entry.detached,
    disabledReason: entry.disabledReason,
    externalTool: entry.externalTool,
    managed: entry.managed,
    name: entry.name,
    path: entry.path,
    primary: entry.primary,
    provenance: entry.provenance,
    repositoryRoot: entry.repositoryRoot,
    usable: entry.usable,
    worktreeId: entry.id,
  };
}

export async function runListWorktrees(
  input: ListWorktreesInput,
  runtimeData: RuntimeData | undefined,
  capability: WorktreeToolCapability | undefined
): Promise<ListWorktreesToolResult> {
  const listed = await requireCapability(capability).list();
  if (!listed.ok) {
    throw new Error(listed.error);
  }
  if (input.root === undefined) {
    return { worktrees: listed.value.map(project) };
  }
  const root = resolveWorkspaceRoot(runtimeData, input.root);
  // Scope by REPOSITORY IDENTITY (`repoCommonDir`), never by path equality or
  // per-checkout `rootId` comparison — both are dead for the primary W5
  // scenario (bot review, PR #2666): `root.path` is only `path.resolve()`'d
  // (normalizeRoot in workspace-roots.ts) while `entry.repositoryRoot` is
  // realpath'd (git-inventory-service.ts), so a symlinked grant never matches
  // on path; and `entry.rootId` is `null` on every sibling worktree AND the
  // primary checkout once the granted root is a MANAGED worktree —
  // `assertWorktreeTargetOutsideRoots` keeps managed worktrees outside every
  // granted root by policy, so only the one entry that IS the granted root
  // (exact realpath mount) ever carries a matching `rootId`.
  //
  // The service already resolved that exact-mount question correctly when it
  // built `rootId` (`buildRootIdByRealPath` in worktree-service.ts) — reusing
  // it here, rather than re-deriving root identity with a second realpath/git
  // call in this module, keeps exactly one seam that knows root→commonDir.
  // Find the entry that IS the granted root, then every entry sharing its
  // `repoCommonDir` (the realpath'd join key `WorktreeListEntry` documents
  // for precisely this) is a worktree of that same repository, primary
  // included.
  const boundEntry = listed.value.find((entry) => entry.rootId === root.rootId);
  if (!boundEntry) {
    // NO SILENT HIDING (spec §13): an empty list here would read as "this
    // workspace has no worktrees" when the real fact is "root isn't
    // resolvable to a worktree entry" — a different, honest error instead.
    throw new Error(`Could not resolve workspace root "${root.displayName}" to a worktree entry.`);
  }
  // Single pass (react-doctor js-combine-iterations): filter+map would walk
  // the list twice for what a bounded worktree count never needs to.
  const worktrees: ListedWorktree[] = [];
  for (const entry of listed.value) {
    if (entry.repoCommonDir === boundEntry.repoCommonDir) {
      worktrees.push(project(entry));
    }
  }
  return { worktrees };
}

/** `bs/bright-fox` → `bright-fox`: a directory name may not contain a slash. */
function directoryNameFor(branch: string): string {
  return branch.split('/').filter(Boolean).at(-1) ?? branch;
}

export async function runManageWorktree(
  input: ManageWorktreeInput,
  runtimeData: RuntimeData | undefined,
  capability: WorktreeToolCapability | undefined
): Promise<ManageWorktreeToolResult> {
  const resolved = requireCapability(capability);
  if (input.action === 'archive') {
    const archived = await resolved.archive({
      ...(input.force === undefined ? {} : { force: input.force }),
      worktreeId: input.worktreeId,
    });
    if (!archived.ok) {
      throw new Error(archived.error);
    }
    return {
      action: 'archive',
      snapshotRef: archived.value.snapshotRef,
      worktreeId: archived.value.worktree.id,
    };
  }
  const root = resolveWorkspaceRoot(runtimeData, input.root);
  const created = await resolved.create({
    baseRef: input.baseRef ?? 'HEAD',
    branch: input.branch,
    name: input.name ?? directoryNameFor(input.branch),
    rootId: root.rootId,
  });
  if (!created.ok) {
    throw new Error(created.error);
  }
  return {
    action: 'create',
    branch: created.value.worktree.branch,
    path: created.value.worktree.path,
    setupReason: created.value.setup.reason,
    setupStatus: created.value.setup.status,
    worktreeId: created.value.worktree.id,
  };
}

/**
 * The two registry entries, keyed by canonical id. Named rather than inferred
 * so the return type is annotated at the function boundary (the repo's
 * "annotate params and return types" rule) and so a typo in a key is a compile
 * error here rather than a missing tool at runtime.
 */
export type WorktreeMastraTools = Record<
  typeof NATIVE_TOOL_ID.listWorktrees | typeof NATIVE_TOOL_ID.manageWorktree,
  {
    readonly description: string;
    readonly execute: (input: never) => Promise<unknown>;
    readonly id: string;
    readonly inputSchema: unknown;
  }
>;

/**
 * The Mastra registry fragment, built HERE rather than inline in
 * `assistant-tools.ts`: that file sits at the 1000-line Biome ceiling and this
 * keeps its growth to one spread.
 */
export function buildWorktreeMastraTools(
  runtimeData: RuntimeData | undefined,
  capability: WorktreeToolCapability | undefined
): WorktreeMastraTools {
  return {
    [NATIVE_TOOL_ID.listWorktrees]: {
      description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.listWorktrees],
      execute: async (input: ToolExecuteInput<ListWorktreesInput>) => {
        const resolvedInput = parseToolExecuteInput(
          NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.listWorktrees],
          input
        );
        try {
          return await runListWorktrees(resolvedInput, runtimeData, capability);
        } catch (error) {
          logger.error('listWorktrees failed', { error });
          throw error;
        }
      },
      id: NATIVE_TOOL_ID.listWorktrees,
      inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.listWorktrees],
    },
    [NATIVE_TOOL_ID.manageWorktree]: {
      description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.manageWorktree],
      execute: async (input: ToolExecuteInput<ManageWorktreeInput>) => {
        // Envelope-validate, then narrow to the clean action branch so the
        // executor receives exactly ManageWorktreeInput (tolerated
        // cross-action extras are stripped here).
        const resolvedInput = normalizeManageWorktreeInput(
          parseToolExecuteInput(NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.manageWorktree], input)
        );
        try {
          return await runManageWorktree(resolvedInput, runtimeData, capability);
        } catch (error) {
          logger.error('manageWorktree failed', { action: resolvedInput.action, error });
          throw error;
        }
      },
      id: NATIVE_TOOL_ID.manageWorktree,
      inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.manageWorktree],
    },
  };
}
