import { useFileExplorerStore } from '@brainstrike/file-explorer';
import { Button } from '@brainstrike/ui';
import { Popover, PopoverContent, PopoverTrigger } from '@brainstrike/ui';
import { Settings } from 'lucide-react';
import type React from 'react';
import { useEffect, useState } from 'react';
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

// Main Component
const FileExplorerConfig: React.FC<FileExplorerConfigProps> = ({ filterError, onFilterChange }) => {
  const store = useFileExplorerStore();
  const [isOpen, setIsOpen] = useState(false);
  const [settings, setSettings] = useState<FileExplorerSettings>(() => ({
    includeFilters: store.includeFilters,
    excludeFilters: store.excludeFilters,
    useRegex: store.useRegex,
    maxSelectionCount: store.maxSelectionCount,
    includeProjectTree: store.includeProjectTree,
    folderSummaryThreshold: store.folderSummaryThreshold,
  }));

  useEffect(() => {
    if (!isOpen) return;

    setSettings({
      includeFilters: store.includeFilters,
      excludeFilters: store.excludeFilters,
      useRegex: store.useRegex,
      maxSelectionCount: store.maxSelectionCount,
      includeProjectTree: store.includeProjectTree,
      folderSummaryThreshold: store.folderSummaryThreshold,
    });
  }, [isOpen, store]);

  const handleSettingChange = <K extends keyof FileExplorerSettings>(
    key: K,
    value: FileExplorerSettings[K]
  ) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const handleApplySettings = () => {
    const {
      maxSelectionCount,
      useRegex,
      includeFilters,
      excludeFilters,
      includeProjectTree,
      folderSummaryThreshold,
    } = settings;

    store.setMaxSelectionCount(maxSelectionCount);
    store.setUseRegex(useRegex);
    store.setFilters(includeFilters, excludeFilters);
    store.setIncludeProjectTree(includeProjectTree);
    store.setFolderSummaryThreshold(folderSummaryThreshold);

    onFilterChange(includeFilters, excludeFilters, useRegex);
    setIsOpen(false);
  };

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" aria-label="Open settings" className="flex gap-2">
          <Settings className="size-4" data-testid="settings-icon" />
          <span className="hidden md:inline">Settings</span>
        </Button>
      </PopoverTrigger>
      {isOpen && (
        <PopoverContent className="w-screen max-w-sm p-0 @container/settings" asChild>
          <dialog open={isOpen} aria-labelledby="config-title">
            <div className="from-primary/5 to-card bg-gradient-to-t p-4 rounded-t-lg border-b">
              <h4 id="config-title" className="text-lg font-semibold leading-none tracking-tight">
                File Explorer Configuration
              </h4>
              <p className="text-sm text-muted-foreground mt-1">
                Customize behavior and appearance
              </p>
            </div>
            <div className="@container p-4 flex flex-col gap-4">
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
          </dialog>
        </PopoverContent>
      )}
    </Popover>
  );
};

export default FileExplorerConfig;
