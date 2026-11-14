import type { WorktreeRepositorySetupDecision } from '@brainstrike/types';
import type { ReactElement } from 'react';
import { TrustChip } from './trust-chip';
import { WhereChip } from './where-chip';
import { WorkspaceBarDropZone } from './workspace-bar-drop-zone';
import type { WorktreeArchiveConfirmation } from './worktree-archive-confirmation-dialog';

/** A folder mounted in this thread's workspace (primary or secondary). */
export interface WorkspaceBarRoot {
  readonly displayName: string;
  /**
   * While the thread works in a worktree, this secondary is its Local folder:
   * the one a hand-off returns to (BST-1456), which names the project.
   */
  readonly local?: true | undefined;
  /** Absolute path (desktop); absent for web FSA roots. */
  readonly path?: string | undefined;
  /** Non-null when this secondary must stay attached; rendered on its disabled Remove action. */
  readonly removeDisabledReason?: string | undefined;
  /** The workspace no longer serves this folder (BST-1990): runs are refused until it is repaired. */
  readonly removed?: true | undefined;
  /** Why the last reopen of this closed folder failed, as the host said. */
  readonly reopenFailure?: string | undefined;
  /** A reopen of this closed folder is in flight. */
  readonly reopening?: true | undefined;
  readonly rootId: string;
}

/** A previously-used folder the platform can re-mount without a picker. */
export interface WorkspaceBarRecentRoot {
  readonly displayName: string;
  readonly path: string;
}

/**
 * The platform's "reveal in the OS file manager" action. Label and handler
 * travel together so the chip can never name an OS it has no way to open:
 * supplying one without the other is a type error. The caller owns the label
 * (Finder / File Explorer / …); this package never hardcodes an OS name.
 */
export interface WorkspaceBarReveal {
  readonly label: string;
  readonly onReveal: (path: string) => void;
}

/** Read-only git state for the primary root (desktop). */
export interface WorkspaceBarCheckout {
  readonly ahead: number | null;
  readonly behind: number | null;
  /** null = detached HEAD */
  readonly branch: string | null;
  readonly dirty: boolean;
}

export interface WorkspaceBarWorktreeSummary {
  readonly branch: string | null;
  readonly detached: boolean;
  readonly name: string;
  readonly path: string;
  readonly setupReason: string | null;
  readonly setupStatus: 'failed' | 'none' | 'skipped' | 'succeeded';
  readonly worktreeId: string;
}

type WorkspaceBarWorktreeUsability =
  | { readonly disabledReason: null; readonly usable: true }
  | { readonly disabledReason: string; readonly usable: false };

export type WorkspaceBarWorktreeOption = {
  readonly branch: string | null;
  readonly current: boolean;
  readonly externalTool: 'claude-code' | 'codex' | 'cursor' | null;
  readonly managed: boolean;
  readonly name: string;
  readonly path: string;
  readonly remedy: 'grant-access' | null;
  readonly repositoryName: string;
  readonly worktreeId: string | null;
} & WorkspaceBarWorktreeUsability;

/** An archived managed worktree the picker can restore (ADR-0034 decision 7). */
export interface WorkspaceBarArchivedWorktree {
  /** When it was archived (ISO-8601). */
  readonly archivedAt: string;
  readonly branch: string | null;
  readonly name: string;
  readonly path: string;
  readonly worktreeId: string;
}

/**
 * The picker's Archived section: the repository's archived managed worktrees,
 * newest archive first, each with Restore and use.
 */
export interface WorkspaceBarArchivedWorktrees {
  /** Why Restore and use waits, or null: a run keeps the checkout it was admitted with. */
  readonly disabledReason: string | null;
  readonly entries: readonly WorkspaceBarArchivedWorktree[];
  /** Why the archived worktrees could not be read, or null. */
  readonly error: string | null;
  readonly loading: boolean;
  /** Restores the worktree, then moves the thread into it. */
  readonly onRestore: (worktree: WorkspaceBarArchivedWorktree) => void;
  /** Why the last Restore and use did not finish, or null. */
  readonly refusal: string | null;
  /** The worktree being restored, or null. */
  readonly restoringId: string | null;
}

export interface WorkspaceBarWorktreePicker {
  /** Absent where the picker offers no restore. */
  readonly archived?: WorkspaceBarArchivedWorktrees;
  readonly error: string | null;
  readonly loading: boolean;
  readonly onGrantAccess: (() => void) | undefined;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSelect: (option: WorkspaceBarWorktreeOption) => void;
  readonly open: boolean;
  readonly options: readonly WorkspaceBarWorktreeOption[];
}

export interface WorkspaceBarCreateWorktreeRequest {
  readonly baseRef: string;
  readonly branch: { readonly detached: true } | { readonly name: string };
  readonly name: string;
}

export interface WorkspaceBarBaseRefOption {
  readonly label: string;
  readonly value: string;
}

export interface WorkspaceBarRepositorySetupConsent {
  /** The host's standing answer for the script's current bytes, or null. */
  readonly decision: WorktreeRepositorySetupDecision | null;
  /** Records the person's answer with the host; rejects with the host's reason when refused. */
  readonly onDecision: (decision: WorktreeRepositorySetupDecision) => Promise<void>;
  readonly repositoryPath: string;
  readonly scriptPath: string;
}

export interface WorkspaceBarMode {
  readonly archiveConfirmation: WorktreeArchiveConfirmation | null;
  /** Base refs the create sheet offers, most useful first. */
  readonly baseRefs: readonly [WorkspaceBarBaseRefOption, ...WorkspaceBarBaseRefOption[]];
  /**
   * Non-null while the thread's run is in progress: a run keeps the checkout it
   * was admitted with, so the Local row (a hand-off), Other worktree… and
   * Archive say why they wait, as New worktree… does with `createDisabledReason`.
   */
  readonly checkoutChangeDisabledReason: string | null;
  readonly createDisabledReason: string | null;
  readonly defaultBranchPrefix: string;
  readonly defaultName: string;
  /** Non-null ⇒ the where-menu shows why in place of its checkout rows (spec §4.5). */
  readonly disabledReason: string | null;
  /** Resolved `<managedDirectory>/<slug>` parent used for the create sheet's live Location preview. */
  readonly managedParentPath: string;
  /**
   * A settled git status read says the folder is not a repository. The
   * where-control then names the folder with no checkout and no warning; any
   * other `disabledReason` (a status read that failed, a missing worktree) warns.
   */
  readonly notARepository: boolean;
  readonly onArchive: (() => void) | undefined;
  readonly onCreate: (request: WorkspaceBarCreateWorktreeRequest) => Promise<void>;
  readonly onCreateBranchHere: ((branch: string) => Promise<void>) | undefined;
  /** What choosing the Local row does while the thread works in a worktree. */
  readonly onHandOffToLocal: (() => void) | undefined;
  /** Refreshes main-owned create defaults; rejection keeps the sheet closed. */
  readonly onOpenCreateSheet: () => Promise<void>;
  /** Asks the caller to open the controlled "Other worktree…" picker. */
  readonly onOpenPicker: () => void;
  readonly pending: boolean;
  readonly picker: WorkspaceBarWorktreePicker;
  /** Present only while this repository's fallback script needs a decision. */
  readonly repositorySetupConsent: WorkspaceBarRepositorySetupConsent | null;
  readonly setupSummary: string;
  /**
   * The thread's folder by name while it has uncommitted changes, or null. A new
   * worktree starts from a commit, so the create sheet says they stay there.
   */
  readonly uncommittedFolderName: string | null;
  readonly worktree: WorkspaceBarWorktreeSummary | null;
}

/** One local branch row, already gated by app-shell's `buildBranchSwitchModel`. */
export interface WorkspaceBarBranchRow {
  readonly current: boolean;
  /** Non-null exactly when `switchable` is false — never a silent disable. */
  readonly disabledReason: string | null;
  readonly name: string;
  readonly switchable: boolean;
  /** Basename of the worktree holding this branch, or null when it is free. */
  readonly worktreeName: string | null;
}

/**
 * The where-menu's Branch submenu. Absent (web, no git bridge, not a
 * repository) => the Branch row is a read-only summary.
 *
 * `onSwitchInNewWorktree` is OPTIONAL on purpose: the escape from a dirty tree
 * only exists once the worktree capability does (a later layer). Without it a
 * dirty tree shows the complete honest state — the dirty reason on every row —
 * rather than an action that cannot work.
 */
export interface WorkspaceBarBranchMenu {
  readonly onCreateBranch: (name: string) => void;
  /** Absent when the repository has no configured remote. */
  readonly onFetch: (() => void) | undefined;
  readonly onQueryChange: (query: string) => void;
  readonly onSwitch: (branch: string) => void;
  readonly onSwitchInNewWorktree?: ((branch: string) => void) | undefined;
  /** True while a switch/create/fetch is in flight — the menu disables itself. */
  readonly pending: boolean;
  readonly query: string;
  readonly rows: readonly WorkspaceBarBranchRow[];
  /** Non-null when NO row can be switched for a whole-repository reason. */
  readonly scopeReason: string | null;
}

/**
 * One workspace trust question (ADR-0032): a folder whose answer is still
 * missing, and what of this thread's folders it holds back until then.
 */
export interface WorkspaceBarTrustAsk {
  /** The folder the answer is for: the repository, when the thread works in one of its worktrees. */
  readonly displayName: string;
  /** This thread's folders the answer covers, each with what trusting it would load. */
  readonly folders: readonly {
    readonly displayName: string;
    /** "AGENTS.md, 2 skills, and 1 slash command". */
    readonly holds: string;
    readonly rootId: string;
  }[];
  /** How many instructions files, skills, slash commands and subagents those folders hold. */
  readonly held: number;
  /**
   * The parent of the folder the answer is for, when the ask may offer to trust
   * every folder in it too (a trusted location). Absent when none is offered.
   */
  readonly offeredLocation?: string | undefined;
  /** The absolute path the answer is recorded for. */
  readonly path: string;
  /** The answer is a repository's, which its worktrees share (ADR-0034 decision 6). */
  readonly sharedWithWorktrees: boolean;
}

/** The workspace trust chip's questions and the two answers each takes. */
export interface WorkspaceBarTrust {
  /** Why the host refused the last answer; null once one is recorded. */
  readonly actionError: string | null;
  readonly asks: readonly WorkspaceBarTrustAsk[];
  /** The `path` of the ask whose answer is being recorded. */
  readonly busyPath: string | null;
  /** `location` is the ask's `offeredLocation`, passed only when the person ticked its box. */
  readonly onDecide: (
    ask: WorkspaceBarTrustAsk,
    decision: 'restricted' | 'trusted',
    location?: string
  ) => void;
  /** Present while trust could not be read: the chip says so and offers this retry. */
  readonly onRetry: (() => void) | undefined;
}

export interface WorkspaceBarProps {
  /**
   * Non-null disables "Add folder…" and every Recent row instead of letting
   * the OS picker (or a picker-less Recent re-mount) run to completion only
   * to discover the folder cannot be attached to this thread yet (BST-1400).
   * The reason renders the same way a disabled root action's
   * `WorkspaceBarRoot.removeDisabledReason` does.
   */
  readonly addFolderDisabledReason?: string | undefined;
  /** Desktop only — makes the Branch row an interactive switcher submenu. */
  readonly branchMenu?: WorkspaceBarBranchMenu | undefined;
  /** Desktop only — read-only git state for the primary root; undefined hides the Branch row. */
  readonly checkout?: WorkspaceBarCheckout | undefined;
  /**
   * Whether the primary root's checkout status and branch menu have settled
   * at least once — surfaced as `data-checkout-state` on the bar's own
   * element (BST-1400) so e2e can await "checkout resolved" deterministically
   * instead of sampling across a bounded window for the Branch row's
   * absence. Callers that never
   * have an async checkout to await (most pure-component usage) can omit
   * this: it defaults to `'resolved'`, since there is nothing pending.
   */
  readonly checkoutState?: 'pending' | 'resolved' | undefined;
  /**
   * Non-null while the folder actions that would take the thread out of its
   * worktree must wait for its run, as the checkout rows do: Make primary,
   * Remove from this thread on the worktree folder or the Local folder, and Use
   * another folder…. Rendered as each of those rows' disabled reason.
   */
  readonly leaveWorktreeDisabledReason?: string | undefined;
  /** Desktop only — Local / Worktree selection [D1]. Absent ⇒ no checkout rows. */
  readonly mode?: WorkspaceBarMode | undefined;
  readonly onAddFolder: () => void;
  /** Present only when the platform can re-mount a recent folder without a picker (desktop). */
  readonly onAddRecent?: ((path: string) => void) | undefined;
  /** Adds a mounted workspace folder to this thread, with no picker (BST-1990). */
  readonly onAddWorkspaceFolder: (folder: WorkspaceBarRecentRoot) => void;
  readonly onCopyPath?: ((path: string) => void) | undefined;
  /**
   * Receives the drop's `DataTransferItem`s. Present only when the platform
   * can resolve a dropped folder to a path (desktop). Path resolution and
   * mounting live in app-shell; this package stays store-free and
   * Electron-free.
   */
  readonly onDropItems?: ((items: readonly DataTransferItem[]) => void) | undefined;
  readonly onMakePrimary: (rootId: string) => void;
  /**
   * Opens the app's Terminal on a mounted root. Present only when the platform
   * has a terminal bridge (desktop). `rootId` authorizes and `path` is where
   * the shell actually starts — main containment-checks the second against the
   * first, so both travel together.
   */
  readonly onOpenTerminal?: ((rootId: string, path: string) => void) | undefined;
  /** Removes a primary the workspace no longer serves, promoting a live folder (BST-1990). */
  readonly onRemovePrimary: (rootId: string) => void;
  readonly onRemoveSecondary: (rootId: string) => void;
  /** Makes a mounted workspace folder the primary of a thread with no live folder (BST-1990). */
  readonly onUseFolder: (folder: WorkspaceBarRecentRoot) => void;
  /**
   * ADR-0034 decision 3: a count another surface (the Explorer's header) raises
   * to open the where-control, the one place the thread's checkout is changed.
   * Each new value opens it; the value it was first shown with does not.
   */
  readonly openRequest?: number | undefined;
  /**
   * undefined = no folder connected → the where-control renders the "Choose a
   * folder" CTA. Secondaries are only meaningful alongside a primary — callers
   * must not pass `secondaryRoots` without also passing `primaryRoot`. The bar
   * still renders any mounted secondaries in that case (never hides mounted
   * state), but the CTA and "+N" badge stay in their no-primary form.
   */
  readonly primaryRoot?: WorkspaceBarRoot | undefined;
  readonly recentRoots: readonly WorkspaceBarRecentRoot[];
  /** Present only when the platform can reveal a path in its file manager. */
  readonly reveal?: WorkspaceBarReveal | undefined;
  /**
   * ADR-0034: present only while the thread works in a scratch folder the host made for it,
   * which "Turn into a project…" moves to a folder the person chooses.
   */
  readonly scratchProject?: WorkspaceBarScratchProject | undefined;
  readonly secondaryRoots: readonly WorkspaceBarRoot[];
  /**
   * Where the thread works, from its binding (ADR-0034). Desktop only, like
   * `mode`. The closed where-control names the checkout from this, so it keeps
   * saying `Local` or the worktree's name while `mode` is withheld for a git
   * status read. Absent ⇒ the checkout is named only once `mode` is known.
   */
  readonly threadCheckout?: WorkspaceBarThreadCheckout | undefined;
  /**
   * The thread's folders whose agent configuration is held until the person
   * answers (ADR-0032). Absent ⇒ no chip: nothing is held, or no host owns trust.
   */
  readonly trust?: WorkspaceBarTrust | undefined;
  /** The workspace's mounted folders that are not this thread's. */
  readonly workspaceFolders: readonly WorkspaceBarRecentRoot[];
}

/**
 * "Turn into a project…" (ADR-0034 build decisions): the host asks where with the folder picker,
 * moves the thread's scratch folder there and makes it a project the thread keeps working in.
 */
export interface WorkspaceBarScratchProject {
  /** Why it waits, or null: a run keeps the folder it was admitted with. */
  readonly disabledReason: string | null;
  /** Starts it; app-shell shows the outcome, a refusal included. */
  readonly onTurnIntoProject: () => void;
  /** The folder is being moved. */
  readonly pending: boolean;
  /** Why the last one did not finish, as the host said, or null. */
  readonly refusal: string | null;
}

/** The thread's checkout as its binding records it. */
export interface WorkspaceBarThreadCheckout {
  /** The worktree the thread works in; null while it works in its folder itself (Local). */
  readonly worktreePath: string | null;
}

/**
 * The composer workspace bar: the where-control (this thread's folders, its
 * branch and its checkout, ADR-0034) and the workspace trust chip while a
 * folder's answer is missing. Always rendered — its job is orientation, not
 * disambiguation. Pure + prop-driven: app-shell supplies everything, so this
 * package stays store-free.
 */
export const WorkspaceBar = ({
  checkoutState = 'resolved',
  onDropItems,
  trust,
  ...where
}: WorkspaceBarProps): ReactElement => {
  const bar = (
    // A plain container, not a labelled group: each chip carries its own
    // accessible name, and an extra grouping level would only add noise to
    // the composer's screen-reader path.
    <div
      className="bs-composer-workspace"
      data-checkout-state={checkoutState}
      data-testid="workspace-bar"
    >
      <WhereChip {...where} />
      {trust ? <TrustChip trust={trust} /> : null}
    </div>
  );
  // Capability gating by omission (desktop only): no handler ⇒ no wrapper, no
  // ring, no listeners — never a disabled zone.
  return onDropItems ? (
    <WorkspaceBarDropZone onDropItems={onDropItems}>{bar}</WorkspaceBarDropZone>
  ) : (
    bar
  );
};

WorkspaceBar.displayName = 'WorkspaceBar';
