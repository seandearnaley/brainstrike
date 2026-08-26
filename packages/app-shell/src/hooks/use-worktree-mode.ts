/**
 * Everything the composer Mode chip needs, from the thread's point of view.
 *
 * Create ordering is deliberate: create the worktree, mount its folder, then
 * bind the thread. Binding earlier would leave the thread pointing at a root
 * the renderer cannot use.
 */
import type {
  WorkspaceBarBaseRefOption,
  WorkspaceBarCreateWorktreeRequest,
  WorkspaceBarMode,
  WorkspaceBarWorktreeOption,
} from '@brainstrike/assistant-ui';
import { useFileSystem } from '@brainstrike/file-explorer-ui/shell';
import { createLogger } from '@brainstrike/logging';
import type {
  WorktreeCreateContext,
  WorktreeCreateResult,
  WorktreeListEntry,
  WorktreeSettings,
} from '@brainstrike/types';
import { toast } from '@brainstrike/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { resolvePlatformBridge } from '../platform-bridge';
import { resolveWorktreesBridge, type WorktreesBridge } from '../worktrees/worktrees-bridge';

const logger = createLogger('WorktreeMode');

const BASE_REFS: readonly [WorkspaceBarBaseRefOption, ...WorkspaceBarBaseRefOption[]] = [
  { label: 'Current branch', value: 'HEAD' },
  { label: 'Default branch (fresh)', value: 'origin/HEAD' },
];

const FIRST_REQUEST_CREATE_REASON = 'Create a worktree before sending the first request.';

type SettingsState =
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly value: WorktreeSettings };

export interface UseWorktreeModeArgs {
  readonly checkout: {
    readonly branch: string | null;
    readonly mode: 'local' | 'worktree';
    readonly worktreeId: string | null;
    readonly worktreePath: string | null;
  };
  readonly firstRequestState: 'loading' | 'no-thread' | 'sent' | 'unsent';
  readonly isRepository: boolean;
  readonly onHandOffToLocal: () => Promise<void>;
  readonly onSelectWorktree: (worktree: {
    readonly branch: string | null;
    readonly path: string;
    readonly worktreeId: string;
  }) => Promise<void>;
  readonly primaryRootId: string | null;
  readonly primaryRootPath: string | null;
  /** The thread's active run, when it has one, so the operation reaches its timeline. */
  readonly runId: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toastFailure(title: string, description: string): void {
  toast({ description, title, variant: 'destructive' });
}

function rejectWithToast(title: string, description: string): never {
  toastFailure(title, description);
  throw new Error(description);
}

async function createWorktree(
  bridge: WorktreesBridge,
  primaryRootId: string,
  request: WorkspaceBarCreateWorktreeRequest,
  runId: string | null
): Promise<WorktreeCreateResult> {
  let created: Awaited<ReturnType<WorktreesBridge['create']>>;
  try {
    created = await bridge.create({
      baseRef: request.baseRef,
      branch: request.branch,
      createdBy: 'user',
      name: request.name,
      rootId: primaryRootId,
      ...(runId ? { runId } : {}),
    });
  } catch (error) {
    const message = errorMessage(error);
    toastFailure('Worktree creation failed', message);
    throw error instanceof Error ? error : new Error(message);
  }
  if (!created.ok) {
    rejectWithToast('Worktree creation failed', created.error);
  }
  return created.value;
}

async function mountWorktree(
  addRootDirectoryByPath: ReturnType<typeof useFileSystem>['addRootDirectoryByPath'],
  worktreePath: string
): Promise<void> {
  let mounted: Awaited<
    ReturnType<NonNullable<ReturnType<typeof useFileSystem>['addRootDirectoryByPath']>>
  > | null;
  try {
    mounted = (await addRootDirectoryByPath?.(worktreePath)) ?? null;
  } catch (error) {
    const message = errorMessage(error);
    toastFailure('Worktree mount failed', message);
    throw error instanceof Error ? error : new Error(message);
  }
  if (!mounted) {
    rejectWithToast(
      'Worktree mount failed',
      `The worktree was created at ${worktreePath}, but it could not be mounted as a workspace folder.`
    );
  }
}

function toOption(entry: WorktreeListEntry, currentId: string | null): WorkspaceBarWorktreeOption {
  const common = {
    branch: entry.branch,
    current: entry.id !== null && entry.id === currentId,
    externalTool: entry.externalTool,
    managed: entry.managed,
    name: entry.name,
    path: entry.path,
    remedy: entry.remedy,
    repositoryName: entry.repositoryRoot.split('/').filter(Boolean).at(-1) ?? entry.repositoryRoot,
    worktreeId: entry.id,
  } as const;
  if (entry.usable) {
    if (entry.disabledReason !== null) {
      const detail = `Usable worktree "${entry.path}" unexpectedly has a disabled reason.`;
      logger.error('Ledger contract violation', { detail });
      return {
        ...common,
        disabledReason: `Ledger contract violation: ${detail}`,
        usable: false,
      };
    }
    return { ...common, disabledReason: null, usable: true };
  }
  if (!entry.disabledReason) {
    const detail = `Unusable worktree "${entry.path}" is missing its disabled reason.`;
    logger.error('Ledger contract violation', { detail });
    return {
      ...common,
      disabledReason: `Ledger contract violation: ${detail}`,
      usable: false,
    };
  }
  return { ...common, disabledReason: entry.disabledReason, usable: false };
}

function describeSetup(settings: SettingsState): string {
  if (settings.kind === 'loading') {
    return 'Setup details are still loading.';
  }
  if (settings.kind === 'error') {
    return `Setup details are unavailable: ${settings.message}`;
  }
  const { setupCommand } = settings.value;
  if (setupCommand === 'disabled') {
    return 'Setup: disabled in Settings — nothing runs after creation.';
  }
  return setupCommand
    ? `Setup command: ${setupCommand.join(' ')}`
    : 'Setup: the repository’s .brainstrike/worktree-setup.sh, when it has one.';
}

function createDisabledReason(
  firstRequestState: UseWorktreeModeArgs['firstRequestState'],
  settings: SettingsState
): string | null {
  if (firstRequestState === 'no-thread') {
    return 'No thread selected.';
  }
  if (firstRequestState === 'loading') {
    return 'Thread is still loading.';
  }
  if (firstRequestState === 'sent') {
    return FIRST_REQUEST_CREATE_REASON;
  }
  if (settings.kind === 'loading') {
    return 'Worktree settings are still loading.';
  }
  if (settings.kind === 'error') {
    return `Worktree settings are unavailable: ${settings.message}`;
  }
  return null;
}

export function useWorktreeMode(args: UseWorktreeModeArgs): WorkspaceBarMode | undefined {
  const bridge = useMemo(() => resolveWorktreesBridge(), []);
  const platform = useMemo(() => resolvePlatformBridge(), []);
  const fileSystem = useFileSystem();
  const addRootDirectory = fileSystem.addRootDirectory;
  const addRootDirectoryByPath = fileSystem.addRootDirectoryByPath;
  const [settings, setSettings] = useState<SettingsState>({ kind: 'loading' });
  const [entries, setEntries] = useState<readonly WorktreeListEntry[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [listing, setListing] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [createSheetContext, setCreateSheetContext] = useState<WorktreeCreateContext | null>(null);
  const [listRevision, setListRevision] = useState(0);

  useEffect(() => {
    if (!bridge) {
      return;
    }
    let cancelled = false;
    void bridge
      .getSettings()
      .then((result) => {
        if (cancelled) {
          return;
        }
        if (result.ok) {
          setSettings({ kind: 'ready', value: result.value });
          return;
        }
        logger.warn('worktree settings unavailable', { error: result.error });
        setSettings({ kind: 'error', message: result.error });
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        const message = errorMessage(error);
        logger.warn('worktree settings read threw', { error });
        setSettings({ kind: 'error', message });
      });
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  const refreshList = useCallback(
    // A `.then()` chain, not `async`/`await`: an `async` function's body runs
    // SYNCHRONOUSLY up to its first `await`, so `setListing(true)` would fire
    // in the SAME tick as whichever caller invoked this — including the
    // mount effect below, which is exactly what
    // `react-hooks/set-state-in-effect` flags. Chaining on `Promise.resolve()`
    // instead defers every state update to a real microtask, matching the
    // `settings` effect's already-safe `bridge.getSettings().then(...)` shape,
    // for every caller (this hook's OTHER callers are event handlers, where
    // the one-microtask delay is unobservable either way).
    (isCancelled?: () => boolean): Promise<void> => {
      if (!bridge || isCancelled?.()) {
        return Promise.resolve();
      }
      return Promise.resolve()
        .then(() => {
          setListing(true);
          return bridge.list();
        })
        .then((result) => {
          if (isCancelled?.()) {
            return;
          }
          if (result.ok) {
            setEntries(result.value);
            setListError(null);
            return;
          }
          setEntries([]);
          setListError(result.error);
        })
        .catch((error: unknown) => {
          if (isCancelled?.()) {
            return;
          }
          setEntries([]);
          setListError(errorMessage(error));
        })
        .finally(() => {
          if (!isCancelled?.()) {
            setListing(false);
            setListRevision((revision) => revision + 1);
          }
        });
    },
    [bridge]
  );

  const onPickerOpenChange = useCallback(
    (open: boolean): void => {
      setPickerOpen(open);
      if (open) {
        void refreshList();
      }
    },
    [refreshList]
  );

  // Eager, once per bridge: without this, `entries` starts empty and stays
  // empty until the user opens the picker or runs a create/archive/branch
  // mutation. A thread that reloads already bound to a worktree would then
  // show "Local" indefinitely — `currentEntry` can never match anything in
  // an empty list — even though its checkout metadata was persisted
  // correctly. The list is read-only and cheap, so loading it on mount is
  // the same eager pattern `settings` already uses just above.
  useEffect(() => {
    let cancelled = false;
    void refreshList(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [refreshList]);

  const currentWorktreeId = args.checkout.mode === 'worktree' ? args.checkout.worktreeId : null;

  const currentEntry = useMemo(
    () => entries.find((entry) => entry.id !== null && entry.id === currentWorktreeId) ?? null,
    [currentWorktreeId, entries]
  );

  // Retry bookkeeping stays in REFS, read only inside this effect (never
  // during render) — deliberately unchanged from before: any restructuring
  // tried here (state instead of refs, deferring the write, adding an extra
  // gate) made eslint-plugin-react-hooks newly flag the `refreshList` call
  // below for `set-state-in-effect`, even with zero new setState calls of
  // its own — the exact opposite of the goal. `missingWorktreeReason` below
  // no longer reads these; see `hasAttemptedForCurrentId` for its
  // render-safe replacement.
  const retriedAfterListErrorRef = useRef<string | null>(null);
  const refreshedMissingWorktreeIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (currentWorktreeId === null || listRevision === 0) {
      return;
    }
    const retryingListError =
      listError !== null && retriedAfterListErrorRef.current !== currentWorktreeId;
    const refreshingMissingEntry =
      listError === null &&
      currentEntry === null &&
      refreshedMissingWorktreeIdRef.current !== currentWorktreeId;
    if (!(retryingListError || refreshingMissingEntry)) {
      return;
    }
    if (retryingListError) {
      retriedAfterListErrorRef.current = currentWorktreeId;
      // This retry also refreshes the missing-id evidence; a successful empty
      // result must not trigger a redundant third inventory read.
      refreshedMissingWorktreeIdRef.current = currentWorktreeId;
    }
    if (refreshingMissingEntry) {
      refreshedMissingWorktreeIdRef.current = currentWorktreeId;
    }
    let cancelled = false;
    void refreshList(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [currentEntry, currentWorktreeId, listError, listRevision, refreshList]);

  // `missingWorktreeReason` below needs to know "has a refresh completed for
  // this id" WITHOUT reading the refs above during render (that is the
  // `react-hooks/refs` finding this replaces). `listRevision` is already the
  // durable, React-visible signal that a refresh landed — `refreshList`'s own
  // body bumps it, outside this component-level code — so the only new state
  // is a baseline revision "as of when `currentWorktreeId` last changed",
  // maintained with React's OWN "adjusting state while rendering" pattern
  // (blessed exactly for this: derive one piece of state from a prop change,
  // no effect, no ref). Once `listRevision` has advanced past that baseline,
  // treat a refresh as attempted for this id — for either retry reason,
  // matching the refs' shared "also counts as attempted" comment above.
  const [attemptBaseline, setAttemptBaseline] = useState({
    id: currentWorktreeId,
    revision: listRevision,
  });
  if (currentWorktreeId !== attemptBaseline.id) {
    setAttemptBaseline({ id: currentWorktreeId, revision: listRevision });
  }
  const hasAttemptedForCurrentId =
    attemptBaseline.id === currentWorktreeId && listRevision > attemptBaseline.revision;

  const onCreate = useCallback(
    async (request: WorkspaceBarCreateWorktreeRequest): Promise<void> => {
      if (!(bridge && args.primaryRootId)) {
        rejectWithToast('Could not create a worktree', 'Worktrees are not available here.');
      }
      if (args.firstRequestState === 'no-thread') {
        rejectWithToast('Could not create a worktree', 'No thread selected.');
      }
      if (args.firstRequestState === 'loading') {
        rejectWithToast('Could not create a worktree', 'Thread is still loading.');
      }
      if (args.firstRequestState === 'sent') {
        rejectWithToast('Could not create a worktree', FIRST_REQUEST_CREATE_REASON);
      }
      setPending(true);
      try {
        const { setup, worktree } = await createWorktree(
          bridge,
          args.primaryRootId,
          request,
          args.runId
        );
        await mountWorktree(addRootDirectoryByPath, worktree.path);
        try {
          await args.onSelectWorktree({
            branch: worktree.branch,
            path: worktree.path,
            worktreeId: worktree.id,
          });
        } catch (error) {
          const message = errorMessage(error);
          toastFailure(
            'Worktree created, but binding failed',
            `Created the worktree at ${worktree.path}, but binding the thread failed: ${message}. Use "Use existing worktree…" to reconnect this thread to it.`
          );
          throw error instanceof Error ? error : new Error(message);
        }
        if (setup.status === 'failed' || setup.status === 'skipped') {
          toastFailure(
            `Worktree created — setup ${setup.status}`,
            setup.reason ?? 'Setup did not complete.'
          );
        }
        await refreshList();
      } finally {
        setPending(false);
      }
    },
    [
      addRootDirectoryByPath,
      args.firstRequestState,
      args.onSelectWorktree,
      args.primaryRootId,
      args.runId,
      bridge,
      refreshList,
    ]
  );

  const onSelectExisting = useCallback(
    (option: WorkspaceBarWorktreeOption): void => {
      if (!bridge) {
        return;
      }
      setPending(true);
      void Promise.resolve(addRootDirectoryByPath?.(option.path))
        .then((mounted) => {
          if (!mounted) {
            throw new Error(`The worktree at ${option.path} could not be mounted.`);
          }
          if (!option.worktreeId) {
            // Unreachable in practice: `resolveUsability` never marks a row
            // without a ledger id `usable`, so the picker never renders it
            // selectable. Adoption lives on the Worktree Map's card action
            // (Task 6) and the `worktrees:adopt` agent tool (Task 10) —
            // never here. Thrown, not silently skipped, if that ever changes.
            throw new Error(`The worktree at ${option.path} is not yet managed.`);
          }
          return option.worktreeId;
        })
        .then((worktreeId) =>
          args.onSelectWorktree({ branch: option.branch, path: option.path, worktreeId })
        )
        .then(async () => {
          setPickerOpen(false);
          await refreshList();
        })
        .catch((error: unknown) => {
          const message = errorMessage(error);
          logger.error('could not switch to the selected worktree', { error, path: option.path });
          toastFailure('Could not use that worktree', message);
        })
        .finally(() => {
          setPending(false);
        });
    },
    [addRootDirectoryByPath, args.onSelectWorktree, bridge, refreshList]
  );

  const onArchive = useCallback((): void => {
    const worktreeId = args.checkout.worktreeId;
    if (!(bridge && worktreeId)) {
      return;
    }
    setPending(true);
    // Hand off FIRST, archive only once that resolves. Archiving first (the
    // original order) could succeed and then leave a failed hand-off with
    // the thread still bound to a now-archived worktree — `refreshList`
    // turns that into a missing-worktree diagnostic chip, which offers no
    // hand-off or picker action, stranding the thread with no recovery path.
    // With this order: a failed hand-off archives nothing (thread stays
    // safely on the still-live worktree; retry the hand-off/archive), and a
    // failed archive after a successful hand-off leaves the thread safely
    // Local with the worktree still on disk (retry Archive from the
    // picker-side actions, or from the thread that still lists it).
    void (async () => {
      try {
        await args.onHandOffToLocal();
      } catch (error) {
        toastFailure('Could not hand off to Local — worktree not archived', errorMessage(error));
        return;
      }
      try {
        const result = await bridge.archive({
          worktreeId,
          ...(args.runId ? { runId: args.runId } : {}),
        });
        if (!result.ok) {
          toastFailure('Thread handed off — worktree not archived', result.error);
          return;
        }
        await refreshList();
      } catch (error) {
        toastFailure('Thread handed off — worktree not archived', errorMessage(error));
      }
    })().finally(() => {
      setPending(false);
    });
  }, [args.checkout.worktreeId, args.onHandOffToLocal, args.runId, bridge, refreshList]);

  const onHandOffToLocal = useCallback((): void => {
    setPending(true);
    void args
      .onHandOffToLocal()
      .catch((error: unknown) => {
        toastFailure('Could not hand off to Local', errorMessage(error));
      })
      .finally(() => {
        setPending(false);
      });
  }, [args.onHandOffToLocal]);

  const onCreateBranchHere = useCallback(
    async (branch: string): Promise<void> => {
      if (!(bridge && currentEntry?.id && currentEntry.managed && currentEntry.detached)) {
        throw new Error('A managed detached worktree is required to create a branch here.');
      }
      setPending(true);
      try {
        const result = await bridge.createBranchHere({ branch, worktreeId: currentEntry.id });
        if (!result.ok) {
          throw new Error(result.error);
        }
        await refreshList();
        toast({
          description: `Branch ${branch} is now checked out in ${currentEntry.name}.`,
          title: 'Branch created',
        });
      } catch (error) {
        const message = errorMessage(error);
        toastFailure('Branch creation failed', message);
        throw error instanceof Error ? error : new Error(message);
      } finally {
        setPending(false);
      }
    },
    [bridge, currentEntry, refreshList]
  );

  const onGrantAccess = useCallback((): void => {
    void addRootDirectory()
      .then(() => refreshList())
      .catch((error: unknown) => {
        toastFailure('Grant access failed', errorMessage(error));
      });
  }, [addRootDirectory, refreshList]);

  const onOpenCreateSheet = useCallback(async (): Promise<void> => {
    if (!(bridge && args.primaryRootId)) {
      throw new Error('Worktrees are not available here.');
    }
    if (args.firstRequestState === 'no-thread') {
      rejectWithToast('Could not open worktree creation', 'No thread selected.');
    }
    if (args.firstRequestState === 'loading') {
      rejectWithToast('Could not open worktree creation', 'Thread is still loading.');
    }
    if (args.firstRequestState === 'sent') {
      rejectWithToast('Could not open worktree creation', FIRST_REQUEST_CREATE_REASON);
    }
    let result: Awaited<ReturnType<WorktreesBridge['createContext']>>;
    try {
      result = await bridge.createContext({ rootId: args.primaryRootId });
    } catch (error) {
      const message = errorMessage(error);
      toastFailure('Could not prepare worktree creation', message);
      throw error instanceof Error ? error : new Error(message);
    }
    if (!result.ok) {
      rejectWithToast('Could not prepare worktree creation', result.error);
    }
    setCreateSheetContext(result.value);
  }, [args.firstRequestState, args.primaryRootId, bridge]);

  const managedParentPath =
    createSheetContext?.managedParentPath ??
    (settings.kind === 'ready' ? settings.value.managedDirectory : '');
  const defaultName = createSheetContext?.suggestedName ?? currentEntry?.name ?? '';
  const createBranchHereHandler =
    currentEntry?.id && currentEntry.managed && currentEntry.detached
      ? onCreateBranchHere
      : undefined;
  const missingWorktreePath =
    currentWorktreeId && currentEntry === null ? args.checkout.worktreePath : null;
  const missingWorktreeName = missingWorktreePath
    ? (missingWorktreePath.split(/[\\/]/u).filter(Boolean).at(-1) ?? missingWorktreePath)
    : null;
  const missingWorktreeReason =
    missingWorktreeName && listRevision > 0 && !listing && hasAttemptedForCurrentId
      ? listError
        ? `Could not verify the bound worktree because the worktree list is unavailable: ${listError}`
        : `The bound worktree ${currentWorktreeId ?? '(unknown)'} is missing from the refreshed worktree list.`
      : null;

  return useMemo(() => {
    if (!(bridge && args.primaryRootId)) {
      return;
    }
    const disabled = createDisabledReason(args.firstRequestState, settings);
    if (!args.isRepository) {
      return {
        baseRefs: BASE_REFS,
        createDisabledReason: 'Not a git repository',
        defaultBranchPrefix: 'bs/',
        defaultName: '',
        disabledReason: 'Not a git repository',
        localPath: args.primaryRootPath,
        managedParentPath,
        onArchive: undefined,
        onCreate: () => Promise.reject(new Error('Not a git repository')),
        onCreateBranchHere: undefined,
        onHandOffToLocal: undefined,
        onOpenCreateSheet: () => Promise.resolve(),
        onOpenPicker: () => undefined,
        onReveal: undefined,
        pending: false,
        picker: {
          error: null,
          loading: false,
          onGrantAccess: undefined,
          onOpenChange: () => undefined,
          onSelect: () => undefined,
          open: false,
          options: [],
        },
        setupSummary: '',
        worktree: null,
      };
    }
    return {
      baseRefs: BASE_REFS,
      createDisabledReason: disabled,
      defaultBranchPrefix: 'bs/',
      defaultName,
      disabledReason: missingWorktreeReason,
      localPath: args.primaryRootPath,
      managedParentPath,
      onArchive: currentWorktreeId ? onArchive : undefined,
      onCreate,
      onCreateBranchHere: createBranchHereHandler,
      onHandOffToLocal: currentWorktreeId ? onHandOffToLocal : undefined,
      onOpenCreateSheet,
      onOpenPicker: () => onPickerOpenChange(true),
      onReveal:
        platform && currentEntry
          ? () => {
              void platform.showItemInFolder(currentEntry.path);
            }
          : undefined,
      pending,
      picker: {
        error: listError,
        loading: listing,
        onGrantAccess,
        onOpenChange: onPickerOpenChange,
        onSelect: onSelectExisting,
        open: pickerOpen,
        options: entries.map((entry) => toOption(entry, currentWorktreeId)),
      },
      setupSummary: describeSetup(settings),
      worktree:
        currentEntry?.id && currentWorktreeId
          ? {
              branch: currentEntry.branch,
              detached: currentEntry.detached,
              name: currentEntry.name,
              path: currentEntry.path,
              setupReason: currentEntry.setupReason,
              setupStatus: currentEntry.setupStatus,
              worktreeId: currentEntry.id,
            }
          : missingWorktreeName && missingWorktreePath && currentWorktreeId
            ? {
                branch: args.checkout.branch,
                detached: args.checkout.branch === null,
                name: missingWorktreeName,
                path: missingWorktreePath,
                setupReason: missingWorktreeReason,
                setupStatus: 'none',
                worktreeId: currentWorktreeId,
              }
            : null,
    };
  }, [
    args.checkout.branch,
    args.firstRequestState,
    args.isRepository,
    args.primaryRootId,
    args.primaryRootPath,
    bridge,
    createBranchHereHandler,
    currentEntry,
    currentWorktreeId,
    defaultName,
    entries,
    listError,
    listing,
    managedParentPath,
    missingWorktreeName,
    missingWorktreePath,
    missingWorktreeReason,
    onArchive,
    onCreate,
    onGrantAccess,
    onHandOffToLocal,
    onOpenCreateSheet,
    onPickerOpenChange,
    onSelectExisting,
    pending,
    pickerOpen,
    platform,
    settings,
  ]);
}
