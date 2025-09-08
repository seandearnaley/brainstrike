import { Input } from '@brainstrike/ui';

function debounce<Args extends unknown[]>(fn: (...args: Args) => void, wait: number) {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  return (...args: Args) => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), wait);
  };
}

import { AlertCircle } from 'lucide-react';
import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';

interface FileExtensionFilterProps {
  includeFilters: string[];
  excludeFilters: string[];
  onFilterChange: (includeFilters: string[], excludeFilters: string[], useRegex: boolean) => void;
  useRegex: boolean;
  filterError: string | null;
  onDraftChange?: (includeFilters: string[], excludeFilters: string[]) => void;
}

const FileExtensionFilter: React.FC<FileExtensionFilterProps> = ({
  includeFilters,
  excludeFilters,
  onFilterChange,
  useRegex,
  filterError,
  onDraftChange,
}) => {
  const [includeInput, setIncludeInput] = useState(() => includeFilters.join(', '));
  const [excludeInput, setExcludeInput] = useState(() => excludeFilters.join(', '));
  const isFirstMount = useRef(true);

  useEffect(() => {
    if (!isFirstMount.current) return;

    isFirstMount.current = false;
    setIncludeInput(includeFilters.join(', '));
    setExcludeInput(excludeFilters.join(', '));
  }, [includeFilters, excludeFilters]);

  const debouncedFilterChange = useMemo(
    () =>
      debounce((newInclude: string[], newExclude: string[]) => {
        onFilterChange(newInclude, newExclude, useRegex);
      }, 300),
    [onFilterChange, useRegex]
  );

  const handleInputChange = (
    value: string,
    setInput: (value: string) => void,
    otherFilters: string[],
    isInclude: boolean
  ) => {
    setInput(value);

    const newFilters = value
      .split(',')
      .map((f) => f.trim())
      .filter(Boolean);

    const nextInclude = isInclude ? newFilters : otherFilters;
    const nextExclude = isInclude ? otherFilters : newFilters;
    // Notify draft change immediately to update parent state
    onDraftChange?.(nextInclude, nextExclude);
    // Debounced callback for expensive downstream effects
    debouncedFilterChange(nextInclude, nextExclude);
  };

  const handleIncludeInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    handleInputChange(e.target.value, setIncludeInput, excludeFilters, true);
  };

  const handleExcludeInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    handleInputChange(e.target.value, setExcludeInput, includeFilters, false);
  };

  const getPlaceholder = (isInclude: boolean) =>
    useRegex
      ? 'Enter regex patterns, separated by commas'
      : isInclude
        ? 'e.g. *.ts, src/**/*.js'
        : 'e.g. *.test.js, node_modules/**';

  return (
    <div className="space-y-2">
      <div>
        <label htmlFor="include-files" className="text-sm font-medium">
          Files to Include:
        </label>
        <Input
          id="include-files"
          type="text"
          value={includeInput}
          onChange={handleIncludeInputChange}
          placeholder={getPlaceholder(true)}
        />
      </div>
      <div>
        <label htmlFor="exclude-files" className="text-sm font-medium">
          Files to Exclude:
        </label>
        <Input
          id="exclude-files"
          type="text"
          value={excludeInput}
          onChange={handleExcludeInputChange}
          placeholder={getPlaceholder(false)}
        />
      </div>
      {filterError && (
        <div className="flex items-center text-red-600 text-sm mt-1">
          <AlertCircle className="mr-1 h-4 w-4" />
          {filterError}
        </div>
      )}
    </div>
  );
};

export default FileExtensionFilter;
