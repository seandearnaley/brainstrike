import { Schema } from 'effect';
export const STANDALONE_WORKSPACE_CAPABILITY_ERROR =
  'ERR_STANDALONE_WORKSPACE_CAPABILITIES_UNAVAILABLE';
/** Client data only. Membership in the live owner's inventory supplies authority. */
export const CliWorkspaceSelectionSchema = Schema.Struct({
  instructions: Schema.Literals(['inherit', 'off']),
  rootIds: Schema.mutable(Schema.Array(Schema.String.check(Schema.isMinCodePoints(1)))).check(
    Schema.makeFilter((ids) =>
      new Set(ids).size === ids.length ? undefined : { issue: 'Invalid input', path: [] }
    )
  ),
  skills: Schema.Literals(['inherit', 'off']),
});
export const CliWorkspaceRunInputSchema = Schema.Struct({
  kind: Schema.Literal('cli-workspace'),
  version: Schema.Literal(1),
  workspace: CliWorkspaceSelectionSchema,
});
export type CliWorkspaceSelection = (typeof CliWorkspaceSelectionSchema)['Type'];
export type CliWorkspaceRunInput = (typeof CliWorkspaceRunInputSchema)['Type'];
/** Committed owner observations are comparison data, never a source of grants. */
export const CliWorkspaceRootsSchema = Schema.mutable(
  Schema.Array(
    Schema.Struct({
      displayName: Schema.String,
      path: Schema.String,
      rootId: Schema.String.check(Schema.isMinCodePoints(1)),
    })
  )
);
/** Distinguish existing full intent from this envelope without tolerating bad envelopes. */
export function readCliWorkspaceRunInput(input: unknown): CliWorkspaceRunInput | undefined {
  if (input && typeof input === 'object' && 'kind' in input && input.kind === 'cli-workspace') {
    return Schema.decodeUnknownSync(CliWorkspaceRunInputSchema, {
      errors: 'all',
      onExcessProperty: 'error',
    })(input);
  }
  return undefined;
}
interface WorkspaceIntent {
  readonly cliWorkspace?: CliWorkspaceSelection | undefined;
  readonly selectionFolderId?: string | undefined;
  readonly skillsPreference?:
    | {
        readonly disabledSkillKeys: readonly string[];
        readonly masterEnabled: boolean;
      }
    | undefined;
  /** Checked files as context, retired (BST-2019): an older intent's is dropped. */
  readonly workspaceContext?: unknown;
  readonly workspaceInstructionsPreference: {
    readonly masterEnabled: boolean;
    readonly oversizedOptInByRootId: Readonly<Record<string, boolean>>;
  };
}
type MaterializedIntent<T> = Omit<T, keyof WorkspaceIntent> &
  WorkspaceIntent & {
    readonly cliWorkspace: CliWorkspaceSelection;
  };
/** Reduce the owner's intent; no defaults here can create root or home grants. */
export function materializeCliWorkspaceIntent<T extends WorkspaceIntent>(
  owner: T,
  input: CliWorkspaceSelection
): MaterializedIntent<T> {
  const selection = Schema.decodeUnknownSync(CliWorkspaceSelectionSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })(input);
  const ids = new Set(selection.rootIds);
  const {
    cliWorkspace,
    selectionFolderId,
    skillsPreference,
    workspaceContext: _retiredWorkspaceContext,
    workspaceInstructionsPreference,
    ...retained
  } = owner;
  if (cliWorkspace && selection.rootIds.some((id) => !cliWorkspace.rootIds.includes(id))) {
    throw new Error('CLI workspace input cannot widen captured root selection');
  }
  return {
    ...retained,
    cliWorkspace: selection,
    ...(selectionFolderId && ids.has(selectionFolderId) ? { selectionFolderId } : {}),
    ...(selection.skills === 'off' || skillsPreference
      ? {
          skillsPreference: {
            disabledSkillKeys: [...(skillsPreference?.disabledSkillKeys ?? [])],
            masterEnabled:
              selection.skills === 'off' ? false : (skillsPreference?.masterEnabled ?? false),
          },
        }
      : {}),
    workspaceInstructionsPreference: {
      masterEnabled:
        workspaceInstructionsPreference.masterEnabled && selection.instructions !== 'off',
      oversizedOptInByRootId: Object.fromEntries(
        Object.entries(workspaceInstructionsPreference.oversizedOptInByRootId).filter(([id]) =>
          ids.has(id)
        )
      ),
    },
  };
}
/** Preserve exact catalog IDs and the owner's order. A missing selected ID refuses. */
export function selectCliWorkspaceRoots<
  T extends {
    readonly rootId: string;
  },
>(liveRoots: readonly T[], input: CliWorkspaceSelection): T[] {
  const selection = Schema.decodeUnknownSync(CliWorkspaceSelectionSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })(input);
  const liveIds = new Set(liveRoots.map((root) => root.rootId));
  if (selection.rootIds.some((id) => !liveIds.has(id))) {
    throw new Error('A selected canonical workspace root is unknown or revoked');
  }
  const ids = new Set(selection.rootIds);
  return liveRoots.filter((root) => ids.has(root.rootId));
}
/** A fresh owner observation cannot replace the admitted root-to-path mapping. */
export function revalidateCliWorkspaceRoots<
  T extends {
    readonly rootId: string;
    readonly path: string;
  },
>(captured: readonly T[], liveRoots: readonly T[], input: CliWorkspaceSelection): T[] {
  const selected = selectCliWorkspaceRoots(liveRoots, input);
  if (
    selected.some(
      (root) => captured.find((prior) => prior.rootId === root.rootId)?.path !== root.path
    )
  ) {
    throw new Error('A selected canonical workspace root mapping changed');
  }
  return selected;
}
