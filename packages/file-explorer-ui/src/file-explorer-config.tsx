import { Button, Popover, PopoverContent, PopoverTrigger } from '@brainstrike/ui';
import { Settings } from 'lucide-react';
import * as React from 'react';
import { useCallback, useId, useState } from 'react';
import { useFileExplorerStoreContext } from './file-explorer-provider';
import FileExtensionFilter from './file-extension-filter';
import FolderSummaryThresholdSetting from './folder-summary-threshold-setting';
import IncludeProjectTreeSetting from './include-project-tree-setting';
import MaxSelectionCountSetting from './max-selection-count-setting';
import UseRegexSetting from './use-regex-setting';

// Types
interface FileExplorerSettings {
  includeFilters: string[];
  excludeFilters: string[];
  useRegex: boolean;
  maxSelectionCount: number;
  includeProjectTree: boolean;
  folderSummaryThreshold: number;
}

interface FileExplorerConfigProps {
  filterError: string | null;
  onFilterChange: (includeFilters: string[], excludeFilters: string[], useRegex: boolean) => void;
}

// Inner dialog is render-only (no hooks) to avoid HMR hook-order issues
const ConfigDialogContent: React.FC<{
  configTitleId: string;
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
}> = ({
  configTitleId,
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
}) => {
  const handleApplySettings = () => {
    const {
      maxSelectionCount: m,
      useRegex: r,
      includeFilters: i,
      excludeFilters: e,
      includeProjectTree: t,
      folderSummaryThreshold: f,
    } = settings;

    setMaxSelectionCount(m);
    setUseRegex(r);
    setFilters(i, e);
    setIncludeProjectTree(t);
    setFolderSummaryThreshold(f);

    onFilterChange(i, e, r);
    onClose();
  };

  return (
    <div>
      <div className="from-primary/5 to-card bg-gradient-to-t p-4 rounded-t-lg border-b bg-card text-foreground">
        <h4 id={configTitleId} className="text-lg font-semibold leading-none tracking-tight">
          File Explorer Configuration
        </h4>
        <p className="text-sm text-muted-foreground mt-1">Customize behavior and appearance</p>
      </div>
      <div className="@container p-4 flex flex-col gap-4 bg-card text-foreground">
        <div className="grid @md/settings:grid-cols-2 gap-4">
          <MaxSelectionCountSetting
            value={settings.maxSelectionCount}
            onChange={(value) => onSettingsChange('maxSelectionCount', value)}
          />
          <FolderSummaryThresholdSetting
            value={settings.folderSummaryThreshold}
            onChange={(value) => onSettingsChange('folderSummaryThreshold', value)}
          />
        </div>
        <FileExtensionFilter
          includeFilters={settings.includeFilters}
          excludeFilters={settings.excludeFilters}
          onFilterChange={(newInclude: string[], newExclude: string[]) => {
            onSettingsChange('includeFilters', newInclude);
            onSettingsChange('excludeFilters', newExclude);
          }}
          useRegex={settings.useRegex}
          filterError={filterError}
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
        <div className="flex justify-end pt-2 border-t mt-2">
          <Button onClick={handleApplySettings}>Apply Settings</Button>
        </div>
      </div>
    </div>
  );
};

// Non-compiled stateful container to isolate hook layout from compiler HMR
const ConfigDialogContainer: React.FC<
  FileExplorerConfigProps & {
    selectors: {
      includeFilters: string[];
      excludeFilters: string[];
      useRegex: boolean;
      maxSelectionCount: number;
      includeProjectTree: boolean;
      folderSummaryThreshold: number;
    };
    actions: {
      setMaxSelectionCount: (v: number) => void;
      setUseRegex: (v: boolean) => void;
      setFilters: (i: string[], e: string[]) => void;
      setIncludeProjectTree: (v: boolean) => void;
      setFolderSummaryThreshold: (v: number) => void;
    };
  }
> = ({ filterError, onFilterChange, selectors, actions }) => {
  const configTitleId = useId();
  const [isOpen, setIsOpen] = useState(false);
  const [settings, setSettings] = useState<FileExplorerSettings>(() => ({
    includeFilters: selectors.includeFilters,
    excludeFilters: selectors.excludeFilters,
    useRegex: selectors.useRegex,
    maxSelectionCount: selectors.maxSelectionCount,
    includeProjectTree: selectors.includeProjectTree,
    folderSummaryThreshold: selectors.folderSummaryThreshold,
  }));

  // Parse persisted settings once to avoid repeated JSON work on every dialog open
  type PersistedSubset = {
    includeFilters?: string[];
    excludeFilters?: string[];
    useRegex?: boolean;
    maxSelectionCount?: number;
    includeProjectTree?: boolean;
    folderSummaryThreshold?: number;
  };
  const persistedSnapshot = React.useMemo<PersistedSubset | null>(() => {
    try {
      const raw = localStorage.getItem('file-explorer-storage-v4');
      if (!raw) return null;
      const parsed = JSON.parse(raw) as unknown;
      const persisted = (
        parsed && typeof parsed === 'object' && (parsed as { state?: PersistedSubset }).state
          ? (parsed as { state: PersistedSubset }).state
          : (parsed as PersistedSubset)
      ) as PersistedSubset;
      return persisted;
    } catch {
      return null;
    }
  }, []);

  const handleSettingChange = useCallback(
    <K extends keyof FileExplorerSettings>(key: K, value: FileExplorerSettings[K]) => {
      setSettings((prev) => ({ ...prev, [key]: value }));
    },
    []
  );

  // Ensure dialog reflects hydrated store values when opened
  React.useEffect(() => {
    if (!isOpen) return;
    // Start with hydrated store values, then overlay any persisted snapshot fields
    setSettings((prev) => ({
      includeFilters:
        persistedSnapshot?.includeFilters ?? selectors.includeFilters ?? prev.includeFilters,
      excludeFilters:
        persistedSnapshot?.excludeFilters ?? selectors.excludeFilters ?? prev.excludeFilters,
      useRegex: persistedSnapshot?.useRegex ?? selectors.useRegex ?? prev.useRegex,
      maxSelectionCount:
        persistedSnapshot?.maxSelectionCount ??
        selectors.maxSelectionCount ??
        prev.maxSelectionCount,
      includeProjectTree:
        persistedSnapshot?.includeProjectTree ??
        selectors.includeProjectTree ??
        prev.includeProjectTree,
      folderSummaryThreshold:
        persistedSnapshot?.folderSummaryThreshold ??
        selectors.folderSummaryThreshold ??
        prev.folderSummaryThreshold,
    }));
  }, [
    isOpen,
    selectors.includeFilters,
    selectors.excludeFilters,
    selectors.useRegex,
    selectors.maxSelectionCount,
    selectors.includeProjectTree,
    selectors.folderSummaryThreshold,
    persistedSnapshot,
  ]);

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label="Open settings"
          data-testid="settings-button"
          className="flex gap-2"
        >
          <Settings className="size-4" data-testid="settings-icon" />
          <span className="hidden md:inline">Settings</span>
        </Button>
      </PopoverTrigger>
      {isOpen && (
        <PopoverContent className="w-screen max-w-sm p-0 @container/settings" asChild>
          <dialog
            aria-labelledby="config-title"
            open
            className="w-full max-w-sm p-0 rounded-md border bg-card text-foreground"
          >
            <ConfigDialogContent
              configTitleId={configTitleId}
              filterError={filterError}
              onFilterChange={onFilterChange}
              onClose={() => setIsOpen(false)}
              settings={settings}
              onSettingsChange={handleSettingChange}
              setMaxSelectionCount={actions.setMaxSelectionCount}
              setUseRegex={actions.setUseRegex}
              setFilters={actions.setFilters}
              setIncludeProjectTree={actions.setIncludeProjectTree}
              setFolderSummaryThreshold={actions.setFolderSummaryThreshold}
            />
          </dialog>
        </PopoverContent>
      )}
    </Popover>
  );
};

// Main Component (compiled wrapper)
const FileExplorerConfig: React.FC<FileExplorerConfigProps> = React.memo(
  ({ filterError, onFilterChange }) => {
    const store = useFileExplorerStoreContext();
    const [
      includeFilters,
      excludeFilters,
      useRegex,
      maxSelectionCount,
      includeProjectTree,
      folderSummaryThreshold,
      setMaxSelectionCount,
      setUseRegex,
      setFilters,
      setIncludeProjectTree,
      setFolderSummaryThreshold,
    ] = store(
      (s) =>
        [
          s.includeFilters,
          s.excludeFilters,
          s.useRegex,
          s.maxSelectionCount,
          s.includeProjectTree,
          s.folderSummaryThreshold,
          s.setMaxSelectionCount,
          s.setUseRegex,
          s.setFilters,
          s.setIncludeProjectTree,
          s.setFolderSummaryThreshold,
        ] as const
    );

    return (
      <ConfigDialogContainer
        filterError={filterError}
        onFilterChange={onFilterChange}
        selectors={{
          includeFilters,
          excludeFilters,
          useRegex,
          maxSelectionCount,
          includeProjectTree,
          folderSummaryThreshold,
        }}
        actions={{
          setMaxSelectionCount,
          setUseRegex,
          setFilters,
          setIncludeProjectTree,
          setFolderSummaryThreshold,
        }}
      />
    );
  }
);

export default FileExplorerConfig;
