'use client';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useFileExplorerStore } from '@/stores/use-file-explorer-store';
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
        <Button variant="outline" size="sm" aria-label="Open settings">
          <Settings className="h-4 w-4 mr-2" data-testid="settings-icon" />
          Settings
        </Button>
      </PopoverTrigger>
      {isOpen && (
        <PopoverContent className="w-80" asChild>
          <dialog open={isOpen} aria-labelledby="config-title">
            <div className="space-y-4">
              <h4 className="font-medium leading-none">File Explorer Configuration</h4>
              <MaxSelectionCountSetting
                value={settings.maxSelectionCount}
                onChange={(value) => handleSettingChange('maxSelectionCount', value)}
              />
              <FolderSummaryThresholdSetting
                value={settings.folderSummaryThreshold}
                onChange={(value) => handleSettingChange('folderSummaryThreshold', value)}
              />
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
              <UseRegexSetting
                checked={settings.useRegex}
                onChange={(checked) => handleSettingChange('useRegex', checked)}
              />
              <IncludeProjectTreeSetting
                checked={settings.includeProjectTree}
                onChange={(checked) => handleSettingChange('includeProjectTree', checked)}
              />
              <div className="flex justify-end">
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
