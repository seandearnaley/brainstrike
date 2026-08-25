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
import { useCallback, useEffect, useMemo, useState } from 'react';
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
    readonly mode: 'local' | 'worktree';
    readonly worktreeId: string | null;
  };
  readonly hasSentFirstRequest: boolean;
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
  return settings.value.setupCommand
    ? `Setup command: ${settings.value.setupCommand.join(' ')}`
    : 'Setup: the repository’s .brainstrike/worktree-setup.sh, when it has one.';
}

function createDisabledReason(
  hasSentFirstRequest: boolean,
  settings: SettingsState
): string | null {
  if (hasSentFirstRequest) {
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

  const refreshList = useCallback(async (): Promise<void> => {
    if (!bridge) {
      return;
    }
    setListing(true);
    try {
      const result = await bridge.list();
      if (result.ok) {
        setEntries(result.value);
        setListError(null);
        return;
      }
      setEntries([]);
      setListError(result.error);
    } catch (error) {
      setEntries([]);
      setListError(errorMessage(error));
    } finally {
      setListing(false);
    }
  }, [bridge]);

  const onPickerOpenChange = useCallback(
    (open: boolean): void => {
      setPickerOpen(open);
      if (open) {
        void refreshList();
      }
    },
    [refreshList]
  );

  const currentWorktreeId = args.checkout.mode === 'worktree' ? args.checkout.worktreeId : null;
  const currentEntry = useMemo(
    () => entries.find((entry) => entry.id !== null && entry.id === currentWorktreeId) ?? null,
    [currentWorktreeId, entries]
  );

  const onCreate = useCallback(
    async (request: WorkspaceBarCreateWorktreeRequest): Promise<void> => {
      if (!(bridge && args.primaryRootId)) {
        throw new Error('Worktrees are not available here.');
      }
      if (args.hasSentFirstRequest) {
        throw new Error(FIRST_REQUEST_CREATE_REASON);
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
        await args.onSelectWorktree({
          branch: worktree.branch,
          path: worktree.path,
          worktreeId: worktree.id,
        });
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
      args.hasSentFirstRequest,
      args.onSelectWorktree,
      args.primaryRootId,
      args.runId,
      bridge,
      refreshList,
    ]
  );

  const onSelectExisting = useCallback(
    (option: WorkspaceBarWorktreeOption): void => {
      const { worktreeId } = option;
      if (!worktreeId) {
        toast({
          description:
            'This worktree was created outside BrainStrike. Adopting one is coming with the Worktree Map.',
          title: 'Not a managed worktree yet',
        });
        return;
      }
      setPending(true);
      void Promise.resolve(addRootDirectoryByPath?.(option.path))
        .then((mounted) => {
          if (!mounted) {
            throw new Error(`The worktree at ${option.path} could not be mounted.`);
          }
          return args.onSelectWorktree({
            branch: option.branch,
            path: option.path,
            worktreeId,
          });
        })
        .then(() => {
          setPickerOpen(false);
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
    [addRootDirectoryByPath, args.onSelectWorktree]
  );

  const onArchive = useCallback((): void => {
    const worktreeId = args.checkout.worktreeId;
    if (!(bridge && worktreeId)) {
      return;
    }
    setPending(true);
    void bridge
      .archive({ worktreeId, ...(args.runId ? { runId: args.runId } : {}) })
      .then(async (result) => {
        if (!result.ok) {
          toastFailure('Worktree not archived', result.error);
          return;
        }
        await args.onHandOffToLocal();
        await refreshList();
      })
      .catch((error: unknown) => {
        toastFailure('Worktree not archived', errorMessage(error));
      })
      .finally(() => {
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
  }, [args.primaryRootId, bridge]);

  const managedParentPath =
    createSheetContext?.managedParentPath ??
    (settings.kind === 'ready' ? settings.value.managedDirectory : '');
  const defaultName = createSheetContext?.suggestedName ?? currentEntry?.name ?? '';
  const createBranchHereHandler =
    currentEntry?.id && currentEntry.managed && currentEntry.detached
      ? onCreateBranchHere
      : undefined;

  return useMemo(() => {
    if (!(bridge && args.primaryRootId)) {
      return;
    }
    const disabled = createDisabledReason(args.hasSentFirstRequest, settings);
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
      disabledReason: null,
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
          : null,
    };
  }, [
    args.hasSentFirstRequest,
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
