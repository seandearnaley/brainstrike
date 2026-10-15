import type { ComponentType } from 'react';

/**
 * Discriminated union describing WHAT was right-clicked. Surfaces adapt their
 * own node models into these shapes; renderers and actions never see surface
 * types. New surfaces add new kinds here.
 */
export interface FileContextIdentity {
  /** Absolute filesystem path on desktop; null on web (no such concept). */
  absolutePath: string | null;
  name: string;
  /** Null only when an absolute path cannot be safely related to its durable RootId. */
  relativePath: string | null;
  /** Durable root identity. This is commonly a UUID and MUST NOT be treated as a path. */
  rootFolderId: string;
}

export interface AssistantThreadContextIdentity {
  readonly id: string;
  /** Stable assistant-memory owner; thread operations are always resource-scoped. */
  readonly resourceId: string;
  readonly title: string;
}

export type ContextTarget =
  | (FileContextIdentity & {
      entryType: 'file' | 'directory';
      kind: 'file-entry';
    })
  | (FileContextIdentity & {
      kind: 'workspace-file-tab';
      tabId: string;
    })
  | {
      readonly kind: 'workspace-app-tab';
      readonly appId: string;
      readonly label: string;
      readonly placement: 'dynamic' | 'pinned';
    }
  | (FileContextIdentity & {
      kind: 'file-viewer';
      /** Exact, event-time selection snapshot; null means the selection is collapsed. */
      selectionText: string | null;
      /** CodeMirror coordinates from the same event snapshot; null for preview/file-level clicks. */
      sourceRange: { readonly from: number; readonly to: number } | null;
      tabId: string;
      viewMode: 'preview' | 'source';
    })
  | (AssistantThreadContextIdentity & { kind: 'assistant-thread' })
  | (AssistantThreadContextIdentity & { kind: 'assistant-thread-tab' })
  | {
      readonly kind: 'browser-tab';
      readonly tabId: string;
      readonly title: string;
      readonly url: string;
    }
  /**
   * The empty background of a tab strip (BST-1836 §6.4). Strip-level local
   * actions (New, Close All) claim it; `stripId` names the owning strip.
   */
  | { readonly kind: 'tab-strip'; readonly stripId: string }
  | { kind: 'collection'; id: string; name: string }
  | { kind: 'collection-file'; id: string; name: string; path: string | null }
  | { kind: 'chunk'; id: string; content: string }
  | { kind: 'embedding'; id: string; vectorId: string }
  /** Notes-vault tree rows (surface-local actions only; id = `${rootId}:${path}`). */
  | { kind: 'vault-note'; id: string; name: string }
  | { kind: 'vault-folder'; id: string; name: string }
  | { kind: 'vault-root'; id: string; name: string; builtIn: boolean }
  /**
   * A row in the Changes surface's changed-files tree (BST-1114). Field
   * shapes are inlined from `@brainstrike/types`'s `ChangedFileEntry` rather
   * than imported — this package stays dependency-light (React-free,
   * Electron-free, and today free of `@brainstrike/types` too), and the
   * fields it needs are a stable subset of that contract's own doc comments:
   * `path` is relative to `worktreePath`, `repositoryRoot`/`rootId`/
   * `worktreePath` are all null when the entry cannot be resolved to a
   * concrete location on disk.
   */
  | {
      readonly kind: 'changed-file';
      readonly path: string;
      readonly repositoryRoot: string | null;
      readonly rootId: string | null;
      /**
       * Resolved absolute path of the owning workspace ROOT (not a
       * worktree), or `null` when unresolvable. The surface's only source
       * for a journal-sourced entry (`worktreePath: null`, real `rootId`) —
       * without this, `changes.open-file`/`changes.reveal-file` can never
       * resolve an absolute path for an agent-edited file and stay hidden.
       */
      readonly rootPath: string | null;
      readonly worktreePath: string | null;
    }
  /**
   * A worktree row in the Changes surface's repository/worktree tree
   * (BST-1114). Field shapes are inlined from `@brainstrike/types`'s
   * `WorktreeDescriptor` (which extends `GitWorktreeSummary`) for the same
   * dependency-light reason as `changed-file` above.
   */
  | {
      readonly branch: string | null;
      readonly containment: readonly string[] | 'outside-roots';
      readonly kind: 'worktree';
      readonly name: string;
      readonly path: string;
      readonly repositoryRoot: string;
      readonly trust: 'unvalidated' | 'validated';
      readonly trustReason: string | null;
    }
  /**
   * A CONNECTED workspace root — the Explorer's per-root section header
   * (spec §7). This kind closes the `docs/agents/workspace-context.md`
   * DEFERRED ruling ("root headers have no ContextTarget kind yet").
   *
   * `rootId` is the surface's resolved root IDENTITY: the durable `roots.id`
   * when one exists, otherwise the legacy path-as-id the forest already falls
   * back to (`RootSection`'s `rootIdentity`). Like every other durable root id
   * in this union it is commonly a UUID and MUST NOT be treated as a path.
   *
   * `path` is `null` when the root has no absolute path distinct from its
   * name — a browser File-System-Access root, whose `DirectoryHandle.path` IS
   * its `name` (`packages/types/src/file-system.ts`: "on web `path` is only
   * the directory name"). Correction: this name-equality check is NEW
   * normalization logic in `workspaceRootToTarget`, not a rule reused from
   * `RootSectionHeader` — that component's own `path` prop is a plain
   * truthiness check (`{path ? ... : name}`) and its doc says callers must
   * omit the prop for FSA roots; nothing in the header itself compares
   * `path` against a display name. Path-shaped actions gate on the DATA
   * (`isVisible`) and web hides them without any platform check.
   *
   * `isMain` is the workspace-wide MAIN role (`activeRootIds[0]`) the header
   * renders as its "Main" badge — deliberately NOT the workspace bar's
   * per-thread primary, which has a different writer and a different meaning
   * (BST-1393 ruling R1).
   */
  | {
      readonly displayName: string;
      readonly isMain: boolean;
      readonly kind: 'workspace-root';
      readonly path: string | null;
      readonly rootId: string;
    };

export type ContextTargetKind = ContextTarget['kind'];

export type TargetOf<K extends ContextTargetKind> = Extract<ContextTarget, { kind: K }>;

/**
 * Capabilities are constructed by the app shell from the bridges that actually
 * exist (web never constructs 'fs.reveal'). An action missing a required
 * capability is HIDDEN — never disabled, never a stub that fails at click time.
 */
export type CapabilityKey = 'clipboard' | 'fs.reveal' | 'fs.openPath';

export type ActionOutcome = { ok: true; message?: string } | { ok: false; error: string };

export interface ClipboardService {
  writeText: (text: string) => Promise<ActionOutcome>;
}

export interface PlatformFsService {
  openPath: (absolutePath: string) => Promise<ActionOutcome>;
  showItemInFolder: (absolutePath: string) => Promise<ActionOutcome>;
}

export interface ActionServices {
  clipboard?: ClipboardService;
  platformFs?: PlatformFsService;
}

/** Menu group; determines ordering and separator placement. */
export type ActionGroup = 'primary' | 'tree' | 'copy' | 'navigate' | 'inspect' | 'danger';

export type ActionShortcutModifier = 'primary' | 'shift' | 'alt';

/**
 * Semantic shortcut metadata. Renderers translate `primary` to the platform's
 * command modifier; a future Electron menu adapter can map the same structure
 * to native accelerators without parsing presentation strings.
 */
export interface ActionShortcut {
  key: string;
  modifiers: readonly ActionShortcutModifier[];
}

export interface ContextAction<K extends ContextTargetKind = ContextTargetKind> {
  appliesTo: readonly K[];
  group: ActionGroup;
  icon?: ComponentType<{ className?: string }>;
  /** Stable id, namespaced by domain: 'file.copy-relative-path'. */
  id: string;
  /** Transient gating ⇒ item rendered DISABLED (e.g. content still loading). */
  isEnabled?: (target: TargetOf<K>) => boolean;
  /** Data-shaped gating ⇒ item HIDDEN (e.g. Copy Full Path with null absolutePath). */
  isVisible?: (target: TargetOf<K>) => boolean;
  label: string | ((target: TargetOf<K>) => string);
  /** Missing capability ⇒ item HIDDEN (spec decision: hide, don't disable). */
  requiredCapabilities?: readonly CapabilityKey[];
  run: (target: TargetOf<K>, services: ActionServices) => Promise<ActionOutcome>;
  /** Presentation metadata only; keyboard ownership remains with the surface/keybinding layer. */
  shortcut?: ActionShortcut;
}

export type AnyContextAction = ContextAction;

/**
 * Widens a kind-narrowed action for heterogeneous storage. Safe under the
 * invariant that any consumer (the registry invokes `isVisible`; menu
 * renderers invoke `label`, `isEnabled`, and `run`) only calls target-taking
 * members with a target previously filtered through `actionsFor`, which
 * guarantees the target's kind is in `appliesTo` and restores the narrow
 * type at runtime.
 */
export function defineContextAction<K extends ContextTargetKind>(
  action: ContextAction<K>
): AnyContextAction {
  return action as unknown as AnyContextAction;
}
