import { ArrowUpDown, Check, Minus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Checkbox } from '../../components/ui/checkbox';
import { ScrollArea } from '../../components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table';
import { useGitAnalysisStore } from '../../stores/git-analysis-store';
import { useFileExplorerStore } from '../../stores/use-file-explorer-store';
import { encodeFileSelection, isPathSelectedInFolder } from '../../utils/file-selection-utils';

interface SortConfig {
  key: string;
  direction: 'asc' | 'desc';
}

/**
 * Simple "SummaryStat" item that displays a small highlight.
 */
function SummaryStat({
  label,
  value,
  description,
}: {
  label: string;
  value: string | number;
  description?: string;
}) {
  return (
    <div className="border rounded-md p-4 flex flex-col gap-1">
      <div className="text-xl font-bold">{value}</div>
      <div className="text-sm">{label}</div>
      {description && <div className="text-xs text-muted-foreground">{description}</div>}
    </div>
  );
}

export const AnalysisPanel: React.FC = () => {
  const { recentlyTouchedFiles, hotspotData, isAnalyzing, error, analyzeAll } =
    useGitAnalysisStore();

  const { currentFolderId, selectedFilePaths, setSelectedFiles } = useFileExplorerStore();

  const [sortConfig, setSortConfig] = useState<SortConfig>({
    key: 'score',
    direction: 'desc',
  });

  const [fileLimit, setFileLimit] = useState<number>(50);

  // Combine and process data for unified display
  const processedData = useMemo(() => {
    const allFiles = new Map<
      string,
      {
        path: string;
        changes: number;
        score: number;
        lastModified: number;
        type: 'recent' | 'hotspot' | 'both';
        totalLinesChanged?: number;
      }
    >();
    // Process recently touched files
    for (const file of recentlyTouchedFiles) {
      allFiles.set(file.path, {
        path: file.path,
        changes: file.changes,
        score: 0,
        lastModified: file.lastCommitTimestamp,
        type: 'recent',
      });
    }

    // Process and merge hotspots
    for (const file of hotspotData) {
      const existing = allFiles.get(file.path);
      if (existing) {
        allFiles.set(file.path, {
          ...existing,
          score: file.score,
          type: 'both',
          totalLinesChanged: file.totalLinesChanged,
        });
      } else {
        allFiles.set(file.path, {
          path: file.path,
          changes: file.changes,
          score: file.score,
          lastModified: file.lastModified,
          type: 'hotspot',
          totalLinesChanged: file.totalLinesChanged,
        });
      }
    }

    // Convert to array and sort
    return Array.from(allFiles.values()).sort((a, b) => {
      const { key, direction } = sortConfig;
      const multiplier = direction === 'asc' ? 1 : -1;

      switch (key) {
        case 'path':
          return multiplier * a.path.localeCompare(b.path);
        case 'changes':
          return multiplier * (a.changes - b.changes);
        case 'score':
          return multiplier * (a.score - b.score);
        case 'lastModified':
          return multiplier * (a.lastModified - b.lastModified);
        default:
          return 0;
      }
    });
  }, [recentlyTouchedFiles, hotspotData, sortConfig]);

  // Compute selected files from File Explorer state
  const selectedFiles = useMemo(() => {
    if (!currentFolderId) return new Set<string>();

    return new Set(
      processedData
        .map((file) => file.path)
        .filter((path) => isPathSelectedInFolder(selectedFilePaths, currentFolderId, path))
    );
  }, [currentFolderId, selectedFilePaths, processedData]);

  // After the useState for fileLimit, add a new useMemo to compute displayedFiles
  const displayedFiles = useMemo(
    () => processedData.slice(0, fileLimit),
    [processedData, fileLimit]
  );

  // Update computed selection states with currentFolderId check
  const allSelected = currentFolderId
    ? displayedFiles.length > 0 &&
      displayedFiles.every((file) =>
        isPathSelectedInFolder(selectedFilePaths, currentFolderId, file.path)
      )
    : false;
  const noneSelected = currentFolderId
    ? displayedFiles.every(
        (file) => !isPathSelectedInFolder(selectedFilePaths, currentFolderId, file.path)
      )
    : true;
  const indeterminate = displayedFiles.length > 0 && !allSelected && !noneSelected;

  // Add debugging logs for selection state (for development only)
  useEffect(() => {
    console.log(
      '[AnalysisPanel] displayedFiles:',
      displayedFiles.map((f) => f.path)
    );
    console.log('[AnalysisPanel] allSelected:', allSelected);
    console.log('[AnalysisPanel] noneSelected:', noneSelected);
    console.log('[AnalysisPanel] indeterminate:', indeterminate);
  }, [displayedFiles, allSelected, noneSelected, indeterminate]);

  const handleSort = useCallback((key: string) => {
    setSortConfig((current) => ({
      key,
      direction: current.key === key && current.direction === 'desc' ? 'asc' : 'desc',
    }));
  }, []);

  // Update handleSelectAll to perform a batch update of the selectedFilePaths state
  const handleSelectAll = useCallback(
    (checked: boolean) => {
      if (!currentFolderId) return;
      const newSelected = new Set(selectedFilePaths);
      for (const file of displayedFiles) {
        const key = encodeFileSelection(currentFolderId, file.path);
        if (checked) {
          newSelected.add(key);
        } else {
          newSelected.delete(key);
        }
      }
      setSelectedFiles(newSelected);
    },
    [currentFolderId, displayedFiles, selectedFilePaths, setSelectedFiles]
  );

  const handleSelectFile = useCallback(
    (path: string, checked: boolean) => {
      if (!currentFolderId) return;
      const newSelected = new Set(selectedFilePaths);
      const key = encodeFileSelection(currentFolderId, path);
      if (checked) {
        newSelected.add(key);
      } else {
        newSelected.delete(key);
      }
      setSelectedFiles(newSelected);
    },
    [currentFolderId, selectedFilePaths, setSelectedFiles]
  );

  const renderSortButton = useCallback(
    (label: string, key: string) => (
      <Button
        variant="ghost"
        onClick={() => handleSort(key)}
        className="h-8 flex items-center gap-1 -ml-3"
      >
        {label}
        <ArrowUpDown className="h-4 w-4" />
      </Button>
    ),
    [handleSort]
  );

  const totalUniqueFiles = useMemo(
    () => new Set([...recentlyTouchedFiles, ...hotspotData].map((f) => f.path)).size,
    [recentlyTouchedFiles, hotspotData]
  );

  // New UI for time-based filtering
  const today = new Date();
  const threeMonthsAgo = new Date(today.getFullYear(), today.getMonth() - 3, today.getDate());
  const [dateRange, setDateRange] = useState({
    startDate: threeMonthsAgo,
    endDate: today,
  });

  const handleStartDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const date = e.target.value ? new Date(e.target.value) : new Date();
    setDateRange({ startDate: date, endDate: dateRange.endDate });
  };

  const handleEndDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const date = e.target.value ? new Date(e.target.value) : new Date();
    setDateRange({ startDate: dateRange.startDate, endDate: date });
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="p-4 space-y-4 shrink-0">
        <div className="mb-4 flex items-center gap-4">
          <div>
            <label htmlFor="start-date" className="mr-2">
              Start Date:
            </label>
            <input
              id="start-date"
              type="date"
              value={dateRange.startDate ? dateRange.startDate.toISOString().substring(0, 10) : ''}
              onChange={handleStartDateChange}
              className="border rounded p-1 bg-white dark:bg-gray-800 dark:text-gray-100"
            />
          </div>
          <div>
            <label htmlFor="end-date" className="mr-2">
              End Date:
            </label>
            <input
              id="end-date"
              type="date"
              value={dateRange.endDate ? dateRange.endDate.toISOString().substring(0, 10) : ''}
              onChange={handleEndDateChange}
              className="border rounded p-1 bg-white dark:bg-gray-800 dark:text-gray-100"
            />
          </div>
          <Button onClick={analyzeAll} disabled={isAnalyzing}>
            {isAnalyzing ? 'Analyzing...' : 'Analyze Time Range'}
          </Button>
        </div>

        {/* Controls */}
        <div className="flex items-center justify-between space-x-2 mb-6">
          <div className="flex items-center space-x-4">
            <div className="flex items-center space-x-2">
              <Select
                value={fileLimit.toString()}
                onValueChange={(value) => setFileLimit(Number.parseInt(value, 10))}
              >
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="File Limit" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="10">10 files</SelectItem>
                  <SelectItem value="20">20 files</SelectItem>
                  <SelectItem value="50">50 files</SelectItem>
                  <SelectItem value="100">100 files</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {selectedFiles.size > 0 && (
              <div className="text-sm text-muted-foreground">
                {selectedFiles.size} file{selectedFiles.size === 1 ? '' : 's'} selected
              </div>
            )}
          </div>
        </div>

        {/* Summary Stats */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <SummaryStat
            label="Total Changed Files"
            value={totalUniqueFiles}
            description="Unique files across all analyses"
          />
          <SummaryStat
            label="Recent Files"
            value={recentlyTouchedFiles.length}
            description="Files with recent changes"
          />
          <SummaryStat
            label="Hotspots"
            value={hotspotData.length}
            description="Files with significant activity"
          />
        </div>

        {error && (
          <div className="text-red-500 p-4 mb-4 border border-red-200 rounded">{error}</div>
        )}
      </div>

      {/* Unified Table View */}
      <div className="flex-1 overflow-hidden">
        <ScrollArea className="h-full">
          <div className="p-4">
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[40px]">
                      <Checkbox
                        checked={indeterminate ? 'indeterminate' : allSelected}
                        onCheckedChange={(checked) => handleSelectAll(checked === true)}
                        aria-label="Select all files"
                        className="ml-2"
                      >
                        {indeterminate ? (
                          <Minus className="h-4 w-4" />
                        ) : allSelected ? (
                          <Check className="h-4 w-4" />
                        ) : null}
                      </Checkbox>
                    </TableHead>
                    <TableHead className="min-w-[100px] max-w-[250px] w-full">
                      {renderSortButton('File Path', 'path')}
                    </TableHead>
                    <TableHead className="w-[100px]">
                      {renderSortButton('Changes', 'changes')}
                    </TableHead>
                    <TableHead className="w-[80px]">{renderSortButton('Score', 'score')}</TableHead>
                    <TableHead className="w-[160px]">
                      {renderSortButton('Last Modified', 'lastModified')}
                    </TableHead>
                    <TableHead className="w-[80px]">Type</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {displayedFiles.map((file) => (
                    <TableRow key={file.path}>
                      <TableCell className="w-[40px]">
                        <Checkbox
                          checked={selectedFiles.has(file.path)}
                          onCheckedChange={(checked) =>
                            handleSelectFile(file.path, checked as boolean)
                          }
                          aria-label={`Select ${file.path}`}
                          className="ml-2"
                        />
                      </TableCell>
                      <TableCell className="font-mono min-w-[100px] max-w-[250px] w-full">
                        <div
                          className="truncate text-left rtl:text-right"
                          dir="rtl"
                          title={file.path}
                        >
                          {file.path}
                        </div>
                      </TableCell>
                      <TableCell className="w-[100px]">
                        {file.changes}
                        {file.totalLinesChanged && ` (${file.totalLinesChanged} lines)`}
                      </TableCell>
                      <TableCell className="w-[80px]">
                        {file.score > 0 ? file.score.toFixed(2) : '-'}
                      </TableCell>
                      <TableCell className="whitespace-nowrap w-[160px]">
                        {new Date(file.lastModified * 1000).toLocaleString()}
                      </TableCell>
                      <TableCell className="w-[80px]">
                        <div
                          className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${
                            file.type === 'both'
                              ? 'bg-purple-100 text-purple-800'
                              : file.type === 'hotspot'
                                ? 'bg-amber-100 text-amber-800'
                                : 'bg-blue-100 text-blue-800'
                          }`}
                        >
                          {file.type === 'both'
                            ? 'Both'
                            : file.type === 'hotspot'
                              ? 'Hotspot'
                              : 'Recent'}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  );
};
