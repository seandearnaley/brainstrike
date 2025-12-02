import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@brainstrike/ui';
import { createLogger, isDevEnv } from '@brainstrike/utils';
import { Settings } from 'lucide-react';
import * as React from 'react';
import { useCallback, useState } from 'react';
import { useFileExplorerStoreContext } from './file-explorer-provider';
import FileExtensionFilter from './file-extension-filter';
import FolderSummaryThresholdSetting from './folder-summary-threshold-setting';
import IncludeProjectTreeSetting from './include-project-tree-setting';
import InlineFixtureSetting from './inline-fixture-setting';
import MaxSelectionCountSetting from './max-selection-count-setting';
import UseRegexSetting from './use-regex-setting';

// Types
type FileExplorerSettings = {
  includeFilters: string[];
  excludeFilters: string[];
  useRegex: boolean;
  maxSelectionCount: number;
  includeProjectTree: boolean;
  folderSummaryThreshold: number;
  devInlineFixtureEnabled: boolean;
};

type WorkspaceSettingsProps = {
  filterError: string | null;
  onFilterChange: (includeFilters: string[], excludeFilters: string[], useRegex: boolean) => void;
  inlineFixtureSetting?: {
    available: boolean;
    loading: boolean;
  };
};

const logger = createLogger('WorkspaceSettings');
export const workspaceSettingsLogger = logger;

type InlineFixtureToggleDependencies = {
  onSettingsChange: (key: 'devInlineFixtureEnabled', value: boolean) => void;
  persistPatch: (patch: Partial<FileExplorerSettings>) => Promise<void> | void;
  setDevInlineFixtureEnabled: (value: boolean) => void;
};

export const createInlineFixtureToggleHandler =
  (deps: InlineFixtureToggleDependencies) => async (checked: boolean) => {
    deps.onSettingsChange('devInlineFixtureEnabled', checked);
    deps.setDevInlineFixtureEnabled(checked);
    try {
      await deps.persistPatch({ devInlineFixtureEnabled: checked });
    } catch (error) {
      if (isDevEnv()) {
        logger.warn('Failed to persist inline fixture toggle', { error });
      }
    }
  };

// Inner dialog is render-only (no hooks) to avoid HMR hook-order issues
const ConfigDialogContent: React.FC<{
  filterError: string | null;
  onFilterChange: (i: string[], e: string[], r: boolean) => void;
  onClose: () => void;
  settings: FileExplorerSettings;
  onSettingsChange: <K extends keyof FileExplorerSettings>(
    key: K,
    value: FileExplorerSettings[K]
  ) => void;
  setMaxSelectionCount: (v: number) => void;
  setUseRegex: (v: boolean) => void;
  setFilters: (i: string[], e: string[]) => void;
  setIncludeProjectTree: (v: boolean) => void;
  setFolderSummaryThreshold: (v: number) => void;
  persistPatch: (patch: Partial<FileExplorerSettings>) => Promise<void> | void;
  setDevInlineFixtureEnabled: (v: boolean) => void;
  inlineFixtureSetting?: {
    available: boolean;
    loading: boolean;
  };
}> = ({
  filterError,
  onFilterChange,
  onClose,
  settings,
  onSettingsChange,
  setMaxSelectionCount,
  setUseRegex,
  setFilters,
  setIncludeProjectTree,
  setFolderSummaryThreshold,
  persistPatch,
  setDevInlineFixtureEnabled,
  inlineFixtureSetting,
}) => {
  const handleApplySettings = async () => {
    const {
      maxSelectionCount: m,
      useRegex: r,
      includeFilters: i,
      excludeFilters: e,
      includeProjectTree: t,
      folderSummaryThreshold: f,
      devInlineFixtureEnabled: fixtureEnabled,
    } = settings;

    setMaxSelectionCount(m);
    setUseRegex(r);
    setFilters(i, e);
    setIncludeProjectTree(t);
    setFolderSummaryThreshold(f);
    setDevInlineFixtureEnabled(fixtureEnabled);

    onFilterChange(i, e, r);

    // Defensive: ask store's persist storage to write a merged patch synchronously if available
    try {
      await persistPatch({
        maxSelectionCount: m,
        useRegex: r,
        includeFilters: i,
        excludeFilters: e,
        includeProjectTree: t,
        folderSummaryThreshold: f,
        devInlineFixtureEnabled: fixtureEnabled,
      });
    } catch {}
    // Allow persist middleware a brief window to flush writes to storage before closing
    await new Promise((resolve) => setTimeout(resolve, 50));
    onClose();
  };

  const handleInlineFixtureToggle = React.useMemo(
    () =>
      createInlineFixtureToggleHandler({
        onSettingsChange,
        persistPatch,
        setDevInlineFixtureEnabled,
      }),
    [onSettingsChange, persistPatch, setDevInlineFixtureEnabled]
  );

  return (
    <div>
      <div className="rounded-t-lg border-b bg-card bg-gradient-to-t from-primary/5 to-card p-4 text-foreground">
        <DialogTitle className="font-semibold text-lg leading-none tracking-tight">
          Workspace Settings
        </DialogTitle>
        <DialogDescription className="mt-1 text-muted-foreground text-sm">
          Configure file explorer behavior for this workspace
        </DialogDescription>
      </div>
      <div className="@container flex flex-col gap-4 bg-card p-4 text-foreground">
        <div className="grid @md/settings:grid-cols-2 gap-4">
          <MaxSelectionCountSetting
            onChange={(value) => onSettingsChange('maxSelectionCount', value)}
            value={settings.maxSelectionCount}
          />
          <FolderSummaryThresholdSetting
            onChange={(value) => onSettingsChange('folderSummaryThreshold', value)}
            value={settings.folderSummaryThreshold}
          />
        </div>
        <FileExtensionFilter
          excludeFilters={settings.excludeFilters}
          filterError={filterError}
          includeFilters={settings.includeFilters}
          onDraftChange={(newInclude: string[], newExclude: string[]) => {
            onSettingsChange('includeFilters', newInclude);
            onSettingsChange('excludeFilters', newExclude);
          }}
          onFilterChange={(newInclude: string[], newExclude: string[]) => {
            onSettingsChange('includeFilters', newInclude);
            onSettingsChange('excludeFilters', newExclude);
          }}
          useRegex={settings.useRegex}
        />
        <div className="grid @md/settings:grid-cols-2 gap-4">
          <UseRegexSetting
            checked={settings.useRegex}
            onChange={(checked) => onSettingsChange('useRegex', checked)}
          />
          <IncludeProjectTreeSetting
            checked={settings.includeProjectTree}
            onChange={(checked) => onSettingsChange('includeProjectTree', checked)}
          />
        </div>
        {inlineFixtureSetting?.available && (
          <InlineFixtureSetting
            checked={settings.devInlineFixtureEnabled}
            disabled={inlineFixtureSetting.loading}
            onChange={handleInlineFixtureToggle}
          />
        )}
        <div className="mt-2 flex justify-end border-t pt-2">
          <Button
            data-testid="apply-settings-button"
            disabled={inlineFixtureSetting?.loading}
            onClick={handleApplySettings}
          >
            Apply Settings
          </Button>
        </div>
      </div>
    </div>
  );
};

// Non-compiled stateful container to isolate hook layout from compiler HMR
const SettingsDialogContainer: React.FC<
  WorkspaceSettingsProps & {
    selectors: {
      includeFilters: string[];
      excludeFilters: string[];
      useRegex: boolean;
      maxSelectionCount: number;
      includeProjectTree: boolean;
      folderSummaryThreshold: number;
      devInlineFixtureEnabled: boolean;
    };
    actions: {
      setMaxSelectionCount: (v: number) => void;
      setUseRegex: (v: boolean) => void;
      setFilters: (i: string[], e: string[]) => void;
      setIncludeProjectTree: (v: boolean) => void;
      setFolderSummaryThreshold: (v: number) => void;
      setDevInlineFixtureEnabled: (v: boolean) => void;
    };
    persistPatch: (patch: Partial<FileExplorerSettings>) => Promise<void> | void;
  }
> = ({ filterError, onFilterChange, selectors, actions, persistPatch, inlineFixtureSetting }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [settings, setSettings] = useState<FileExplorerSettings>(() => ({
    includeFilters: selectors.includeFilters,
    excludeFilters: selectors.excludeFilters,
    useRegex: selectors.useRegex,
    maxSelectionCount: selectors.maxSelectionCount,
    includeProjectTree: selectors.includeProjectTree,
    folderSummaryThreshold: selectors.folderSummaryThreshold,
    devInlineFixtureEnabled: selectors.devInlineFixtureEnabled,
  }));

  const handleSettingChange = useCallback(
    <K extends keyof FileExplorerSettings>(key: K, value: FileExplorerSettings[K]) => {
      setSettings((prev) => ({ ...prev, [key]: value }));
    },
    []
  );

  // Ensure dialog reflects hydrated store values when opened
  React.useEffect(() => {
    if (!isOpen) {
      return;
    }
    // Use hydrated store values as the single source of truth
    setSettings((prev) => ({
      includeFilters: selectors.includeFilters ?? prev.includeFilters,
      excludeFilters: selectors.excludeFilters ?? prev.excludeFilters,
      useRegex: selectors.useRegex ?? prev.useRegex,
      maxSelectionCount: selectors.maxSelectionCount ?? prev.maxSelectionCount,
      includeProjectTree: selectors.includeProjectTree ?? prev.includeProjectTree,
      folderSummaryThreshold: selectors.folderSummaryThreshold ?? prev.folderSummaryThreshold,
      devInlineFixtureEnabled: selectors.devInlineFixtureEnabled ?? prev.devInlineFixtureEnabled,
    }));
  }, [
    isOpen,
    selectors.includeFilters,
    selectors.excludeFilters,
    selectors.useRegex,
    selectors.maxSelectionCount,
    selectors.includeProjectTree,
    selectors.folderSummaryThreshold,
    selectors.devInlineFixtureEnabled,
  ]);

  return (
    <Dialog onOpenChange={setIsOpen} open={isOpen}>
      <DialogTrigger asChild>
        <Button
          aria-label="Open settings"
          className="flex gap-2"
          data-testid="settings-button"
          size="sm"
          variant="outline"
        >
          <Settings className="size-4" data-testid="settings-icon" />
          <span className="hidden md:inline">Settings</span>
        </Button>
      </DialogTrigger>
      {isOpen && (
        <DialogContent
          className="w-full max-w-sm rounded-md border bg-card p-0 text-foreground"
          data-testid="settings-dialog"
        >
          <ConfigDialogContent
            filterError={filterError}
            onClose={() => setIsOpen(false)}
            onFilterChange={onFilterChange}
            onSettingsChange={handleSettingChange}
            persistPatch={persistPatch}
            setDevInlineFixtureEnabled={actions.setDevInlineFixtureEnabled}
            setFilters={actions.setFilters}
            setFolderSummaryThreshold={actions.setFolderSummaryThreshold}
            setIncludeProjectTree={actions.setIncludeProjectTree}
            setMaxSelectionCount={actions.setMaxSelectionCount}
            settings={settings}
            setUseRegex={actions.setUseRegex}
            {...(inlineFixtureSetting ? { inlineFixtureSetting } : {})}
          />
        </DialogContent>
      )}
    </Dialog>
  );
};

// Main Component (compiled wrapper)
const WorkspaceSettings: React.FC<WorkspaceSettingsProps> = React.memo(
  ({ filterError, onFilterChange, inlineFixtureSetting }) => {
    const store = useFileExplorerStoreContext();
    const [
      includeFilters,
      excludeFilters,
      useRegex,
      maxSelectionCount,
      includeProjectTree,
      folderSummaryThreshold,
      devInlineFixtureEnabled,
      setMaxSelectionCount,
      setUseRegex,
      setFilters,
      setIncludeProjectTree,
      setFolderSummaryThreshold,
      setDevInlineFixtureEnabled,
    ] = store(
      (s) =>
        [
          s.includeFilters,
          s.excludeFilters,
          s.useRegex,
          s.maxSelectionCount,
          s.includeProjectTree,
          s.folderSummaryThreshold,
          s.devInlineFixtureEnabled,
          s.setMaxSelectionCount,
          s.setUseRegex,
          s.setFilters,
          s.setIncludeProjectTree,
          s.setFolderSummaryThreshold,
          s.setDevInlineFixtureEnabled,
        ] as const
    );

    // Helper to get storage from persist API
    const getStorage = () => {
      const persistApi = (
        store as unknown as {
          persist?: {
            getOptions?: () => {
              name?: string;
              storage?: {
                getItem: (key: string) => Promise<string | null> | string | null;
                setItem: (key: string, value: string) => Promise<void> | void;
              };
            };
          };
        }
      ).persist;

      if (!persistApi || typeof persistApi.getOptions !== 'function') {
        return null;
      }

      const opts = persistApi.getOptions();
      const storage = opts?.storage;
      if (
        !storage ||
        typeof storage.getItem !== 'function' ||
        typeof storage.setItem !== 'function'
      ) {
        return null;
      }

      return { storage, name: opts?.name ?? 'file-explorer-storage-v4' };
    };

    // Helper to merge patch with existing state
    const mergeStateWithPatch = (current: unknown, patch: Partial<FileExplorerSettings>) => {
      const hasWrapper = current && typeof current === 'object' && 'state' in current;
      const base = (hasWrapper ? (current as { state: unknown }).state : current) || {};
      const merged = { ...base, ...patch };
      return hasWrapper ? { ...current, state: merged } : { version: 1, state: merged };
    };

    // Persist patch via the same storage used by the store's persist layer (worker/localStorage)
    const persistPatch = async (patch: Partial<FileExplorerSettings>) => {
      try {
        const storageInfo = getStorage();
        if (!storageInfo) {
          return;
        }

        const { storage, name } = storageInfo;
        const currentJson = await storage.getItem(name);
        const current = currentJson ? JSON.parse(currentJson) : {};
        const wrapper = mergeStateWithPatch(current, patch);
        await storage.setItem(name, JSON.stringify(wrapper));
      } catch (error) {
        if (isDevEnv()) {
          logger.warn('Failed to persist file explorer settings patch', { error });
        }
      }
    };

    return (
      <SettingsDialogContainer
        actions={{
          setMaxSelectionCount,
          setUseRegex,
          setFilters,
          setIncludeProjectTree,
          setFolderSummaryThreshold,
          setDevInlineFixtureEnabled,
        }}
        filterError={filterError}
        onFilterChange={onFilterChange}
        persistPatch={persistPatch}
        selectors={{
          includeFilters,
          excludeFilters,
          useRegex,
          maxSelectionCount,
          includeProjectTree,
          folderSummaryThreshold,
          devInlineFixtureEnabled,
        }}
        {...(inlineFixtureSetting ? { inlineFixtureSetting } : {})}
      />
    );
  }
);

export { ConfigDialogContent };
export default WorkspaceSettings;
