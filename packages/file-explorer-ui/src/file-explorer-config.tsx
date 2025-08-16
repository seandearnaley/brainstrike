import { Button, Popover, PopoverContent, PopoverTrigger } from '@brainstrike/ui';
import { Settings } from 'lucide-react';
import * as React from 'react';
import { useState } from 'react';
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

// Inner dialog content kept uncompiled to avoid HMR hook-order issues
const ConfigDialogContent: React.FC<
  {
    filterError: string | null;
    onFilterChange: (i: string[], e: string[], r: boolean) => void;
    onClose: () => void;
  } & Pick<
    FileExplorerSettings,
    | 'includeFilters'
    | 'excludeFilters'
    | 'useRegex'
    | 'maxSelectionCount'
    | 'includeProjectTree'
    | 'folderSummaryThreshold'
  > & {
      setMaxSelectionCount: (v: number) => void;
      setUseRegex: (v: boolean) => void;
      setFilters: (i: string[], e: string[]) => void;
      setIncludeProjectTree: (v: boolean) => void;
      setFolderSummaryThreshold: (v: number) => void;
    }
> = ({
  filterError,
  onFilterChange,
  onClose,
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
}) => {
  const [settings, setSettings] = useState<FileExplorerSettings>(() => ({
    includeFilters,
    excludeFilters,
    useRegex,
    maxSelectionCount,
    includeProjectTree,
    folderSummaryThreshold,
  }));

  const handleSettingChange = <K extends keyof FileExplorerSettings>(
    key: K,
    value: FileExplorerSettings[K]
  ) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

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
        <h4 id="config-title" className="text-lg font-semibold leading-none tracking-tight">
          File Explorer Configuration
        </h4>
        <p className="text-sm text-muted-foreground mt-1">Customize behavior and appearance</p>
      </div>
      <div className="@container p-4 flex flex-col gap-4 bg-card text-foreground">
        <div className="grid @md/settings:grid-cols-2 gap-4">
          <MaxSelectionCountSetting
            value={settings.maxSelectionCount}
            onChange={(value) => handleSettingChange('maxSelectionCount', value)}
          />
          <FolderSummaryThresholdSetting
            value={settings.folderSummaryThreshold}
            onChange={(value) => handleSettingChange('folderSummaryThreshold', value)}
          />
        </div>
        <FileExtensionFilter
          includeFilters={settings.includeFilters}
          excludeFilters={settings.excludeFilters}
          onFilterChange={(newInclude: string[], newExclude: string[]) => {
            handleSettingChange('includeFilters', newInclude);
            handleSettingChange('excludeFilters', newExclude);
          }}
          useRegex={settings.useRegex}
          filterError={filterError}
        />
        <div className="grid @md/settings:grid-cols-2 gap-4">
          <UseRegexSetting
            checked={settings.useRegex}
            onChange={(checked) => handleSettingChange('useRegex', checked)}
          />
          <IncludeProjectTreeSetting
            checked={settings.includeProjectTree}
            onChange={(checked) => handleSettingChange('includeProjectTree', checked)}
          />
        </div>
        <div className="flex justify-end pt-2 border-t mt-2">
          <Button onClick={handleApplySettings}>Apply Settings</Button>
        </div>
      </div>
    </div>
  );
};

// Main Component (compiled wrapper)
const FileExplorerConfig: React.FC<FileExplorerConfigProps> = React.memo(
  ({ filterError, onFilterChange }) => {
    'use memo';
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

    const [isOpen, setIsOpen] = useState(false);

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
                filterError={filterError}
                onFilterChange={onFilterChange}
                onClose={() => setIsOpen(false)}
                includeFilters={includeFilters}
                excludeFilters={excludeFilters}
                useRegex={useRegex}
                maxSelectionCount={maxSelectionCount}
                includeProjectTree={includeProjectTree}
                folderSummaryThreshold={folderSummaryThreshold}
                setMaxSelectionCount={setMaxSelectionCount}
                setUseRegex={setUseRegex}
                setFilters={setFilters}
                setIncludeProjectTree={setIncludeProjectTree}
                setFolderSummaryThreshold={setFolderSummaryThreshold}
              />
            </dialog>
          </PopoverContent>
        )}
      </Popover>
    );
  }
);

export default FileExplorerConfig;
