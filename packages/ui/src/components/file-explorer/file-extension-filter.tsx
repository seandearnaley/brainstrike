import { debounce } from 'lodash';
import { AlertCircle } from 'lucide-react';
import * as React from 'react';
import { Input } from '../../input';

export interface FileExtensionFilterProps {
  includeFilters: string[];
  excludeFilters: string[];
  onFilterChange: (includeFilters: string[], excludeFilters: string[], useRegex: boolean) => void;
  useRegex: boolean;
  filterError: string | null;
}

const FileExtensionFilter: React.FC<FileExtensionFilterProps> = ({
  includeFilters,
  excludeFilters,
  onFilterChange,
  useRegex,
  filterError,
}) => {
  const [includeInput, setIncludeInput] = React.useState(() => includeFilters.join(', '));
  const [excludeInput, setExcludeInput] = React.useState(() => excludeFilters.join(', '));
  const isFirstMount = React.useRef(true);

  React.useEffect(() => {
    if (!isFirstMount.current) return;
    isFirstMount.current = false;
    setIncludeInput(includeFilters.join(', '));
    setExcludeInput(excludeFilters.join(', '));
  }, [includeFilters, excludeFilters]);

  const debouncedFilterChange = React.useMemo(
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

    debouncedFilterChange(
      isInclude ? newFilters : otherFilters,
      isInclude ? otherFilters : newFilters
    );
  };

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
          onChange={(e) => handleInputChange(e.target.value, setIncludeInput, excludeFilters, true)}
          placeholder={
            useRegex ? 'Enter regex patterns, separated by commas' : 'e.g. *.ts, src/**/*.js'
          }
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
          onChange={(e) =>
            handleInputChange(e.target.value, setExcludeInput, includeFilters, false)
          }
          placeholder={
            useRegex
              ? 'Enter regex patterns, separated by commas'
              : 'e.g. *.test.js, node_modules/**'
          }
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
