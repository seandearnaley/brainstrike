import type { LogLevel } from '@brainstrike/logging';
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Label,
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@brainstrike/ui';
import type { Table as ReactTableInstance } from '@tanstack/react-table';
import { Download, ListFilter, RefreshCw, Settings2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { SettingsSearchIcon } from '../../settings-search-icon';
import { SETTINGS_SEARCH_INPUT_STYLE } from '../../settings-search-layout';
import type { LogTableFeatures } from './log-table-features';
import type { LogRecordRow } from './log-utils';

const FILTERS_PANEL_ID = 'log-viewer-filters';

interface LogToolbarProps {
  /** Source, code and time filters away from their defaults; shown on the Filters button. */
  activeFilterCount: number;
  autoScroll: boolean;
  canRefresh: boolean;
  diagnosticFilters: ReactNode;
  globalFilter: string;
  logLevelFilter: LogLevel;
  logLevelItems: ReactNode;
  logsLoading: boolean;
  onAutoScrollChange: (value: boolean) => void;
  onExport: () => void;
  onLevelChange: (value: LogLevel) => void;
  onPageSizeChange: (value: number) => void;
  onRefresh: () => void;
  onRetentionChange: (value: number) => void;
  onScopeChange: (value: string) => void;
  onSearchChange: (value: string) => void;
  onSortNewestFirstChange: (value: boolean) => void;
  onWrapLinesChange: (value: boolean) => void;
  pageSize: number;
  pageSizeItems: ReactNode;
  retentionItems: ReactNode;
  retentionLimit: number;
  rowsCount: number;
  scopeFilter: string;
  scopeItems: ReactNode;
  sortNewestFirst: boolean;
  table: ReactTableInstance<LogTableFeatures, LogRecordRow>;
  wrapLines: boolean;
}

/**
 * One wrapping row of everyday controls, so the log list keeps the pane's height
 * (BST-1791). Source, code, time and list limits open below it on demand.
 */
export function LogToolbar({
  activeFilterCount,
  logLevelFilter,
  onLevelChange,
  logLevelItems,
  scopeFilter,
  onScopeChange,
  scopeItems,
  globalFilter,
  onSearchChange,
  autoScroll,
  onAutoScrollChange,
  wrapLines,
  onWrapLinesChange,
  sortNewestFirst,
  onSortNewestFirstChange,
  retentionLimit,
  onRetentionChange,
  retentionItems,
  pageSize,
  onPageSizeChange,
  pageSizeItems,
  table,
  rowsCount,
  logsLoading,
  onExport,
  onRefresh,
  canRefresh,
  diagnosticFilters,
}: LogToolbarProps) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  return (
    <div className="flex flex-col gap-2 border-border/40 border-b bg-background p-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[10rem] flex-1">
          <SettingsSearchIcon />
          <Input
            className="h-8 border-border/50 bg-muted/50 pl-10 transition-colors focus:bg-background"
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search logs..."
            style={SETTINGS_SEARCH_INPUT_STYLE}
            value={globalFilter}
          />
        </div>
        <Select onValueChange={(value) => onLevelChange(value as LogLevel)} value={logLevelFilter}>
          <SelectTrigger aria-label="Level" className="h-8 w-[7.5rem] border-border/50 bg-muted/50">
            <SelectValue placeholder="Level" />
          </SelectTrigger>
          <SelectContent>{logLevelItems}</SelectContent>
        </Select>
        <Select onValueChange={onScopeChange} value={scopeFilter}>
          <SelectTrigger aria-label="Scope" className="h-8 w-[9rem] border-border/50 bg-muted/50">
            <SelectValue placeholder="Scope" />
          </SelectTrigger>
          <SelectContent>{scopeItems}</SelectContent>
        </Select>
        <div className="flex h-8 items-center gap-2 rounded-md border border-border/30 bg-muted/30 px-2">
          <Switch
            checked={autoScroll}
            className="scale-90"
            id="log-viewer-autoscroll"
            onCheckedChange={onAutoScrollChange}
          />
          <Label className="cursor-pointer font-medium text-xs" htmlFor="log-viewer-autoscroll">
            Auto-scroll
          </Label>
        </div>
        <Button
          aria-controls={FILTERS_PANEL_ID}
          aria-expanded={filtersOpen}
          aria-label={activeFilterCount > 0 ? `Filters, ${activeFilterCount} active` : 'Filters'}
          className="h-8 gap-1.5 bg-muted/30"
          onClick={() => setFiltersOpen((open) => !open)}
          size="sm"
          type="button"
          variant="outline"
        >
          <ListFilter aria-hidden="true" className="h-3.5 w-3.5" />
          Filters
          {activeFilterCount > 0 ? (
            <Badge aria-hidden="true" className="h-4 px-1 text-[10px]">
              {activeFilterCount}
            </Badge>
          ) : null}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button className="h-8 gap-1.5 bg-muted/30" size="sm" variant="outline">
              <Settings2 aria-hidden="true" className="h-3.5 w-3.5" />
              View
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuLabel>Columns</DropdownMenuLabel>
            {table
              .getAllColumns()
              .filter((column) => column.getCanHide())
              .map((column) => (
                <DropdownMenuCheckboxItem
                  checked={column.getIsVisible()}
                  key={column.id}
                  onCheckedChange={(value) => column.toggleVisibility(!!value)}
                >
                  {column.id.charAt(0).toUpperCase() + column.id.slice(1)}
                </DropdownMenuCheckboxItem>
              ))}
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={wrapLines}
              onCheckedChange={(value) => onWrapLinesChange(!!value)}
            >
              Wrap lines
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={sortNewestFirst}
              onCheckedChange={(value) => onSortNewestFirstChange(!!value)}
            >
              Newest first
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          aria-label="Refresh Logs"
          className="h-8 w-8"
          disabled={logsLoading || !canRefresh}
          onClick={onRefresh}
          size="icon"
          title="Refresh Logs"
          variant="ghost"
        >
          <RefreshCw className={`h-4 w-4 ${logsLoading ? 'animate-spin' : ''}`} />
        </Button>
        <Button
          aria-label="Export Logs"
          className="h-8 w-8"
          disabled={rowsCount === 0}
          onClick={onExport}
          size="icon"
          title="Export Logs"
          variant="ghost"
        >
          <Download className="h-4 w-4" />
        </Button>
      </div>

      {filtersOpen ? (
        <div className="flex flex-wrap items-end gap-3" id={FILTERS_PANEL_ID}>
          {diagnosticFilters}
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs" htmlFor="log-viewer-retention">
              Retention
            </Label>
            <Select
              onValueChange={(value) => onRetentionChange(Number(value))}
              value={String(retentionLimit)}
            >
              <SelectTrigger
                className="h-8 w-[8.5rem] border-border/50 bg-muted/40"
                id="log-viewer-retention"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>{retentionItems}</SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs" htmlFor="log-viewer-page-size">
              Page size
            </Label>
            <Select
              onValueChange={(value) => onPageSizeChange(Number(value))}
              value={String(pageSize)}
            >
              <SelectTrigger
                className="h-8 w-[7.5rem] border-border/50 bg-muted/40"
                id="log-viewer-page-size"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>{pageSizeItems}</SelectContent>
            </Select>
          </div>
        </div>
      ) : null}
    </div>
  );
}
