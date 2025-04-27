import { useFileExplorerSettings } from '@brainstrike/hooks';
import type { FileExplorerSettings } from '@brainstrike/types';
import {
  Button,
  FileExtensionFilter,
  FolderSummaryThresholdSetting,
  IncludeProjectTreeSetting,
  MaxSelectionCountSetting,
  Popover,
  PopoverContent,
  PopoverTrigger,
  UseRegexSetting,
} from '@brainstrike/ui';
import { Settings } from 'lucide-react';
import type React from 'react';
import { useEffect, useState } from 'react';
import { useFileExplorerStore } from '../../stores/use-file-explorer-store';

// Types
interface FileExplorerConfigProps {
  filterError: string | null;
  onFilterChange: (includeFilters: string[], excludeFilters: string[], useRegex: boolean) => void;
}

// Main Component
const FileExplorerConfig: React.FC<FileExplorerConfigProps> = ({ filterError, onFilterChange }) => {
  const store = useFileExplorerStore();
  const { settings: persisted, updateSettings } = useFileExplorerSettings();
  const [isOpen, setIsOpen] = useState(false);
  const [settings, setSettings] = useState<FileExplorerSettings>(() => persisted);

  useEffect(() => {
    if (!isOpen) return;

    setSettings(persisted);
  }, [isOpen, persisted]);

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
    updateSettings(settings);
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
                onFilterChange={(newInclude, newExclude) => {
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
