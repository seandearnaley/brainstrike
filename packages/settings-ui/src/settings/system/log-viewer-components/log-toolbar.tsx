import type { LogLevel } from '@brainstrike/logging';
import {
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
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
import { Download, RefreshCw, Settings2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { SettingsSearchIcon } from '../../settings-search-icon';
import { SETTINGS_SEARCH_INPUT_STYLE } from '../../settings-search-layout';
import type { LogTableFeatures } from './log-table-features';
import type { LogRecordRow } from './log-utils';

interface LogToolbarProps {
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

export function LogToolbar({
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
  return (
    <div className="flex flex-col gap-4 border-border/40 border-b bg-background/95 p-4 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex flex-1 flex-wrap items-center gap-3">
          <div className="relative min-w-[220px] flex-1">
            <SettingsSearchIcon />
            <Input
              className="border-border/50 bg-muted/50 pl-10 transition-colors focus:bg-background"
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="Search logs..."
              style={SETTINGS_SEARCH_INPUT_STYLE}
              value={globalFilter}
            />
          </div>
          <Select
            onValueChange={(value) => onLevelChange(value as LogLevel)}
            value={logLevelFilter}
          >
            <SelectTrigger aria-label="Level" className="w-[140px] border-border/50 bg-muted/50">
              <SelectValue placeholder="Level" />
            </SelectTrigger>
            <SelectContent>{logLevelItems}</SelectContent>
          </Select>
          <Select onValueChange={onScopeChange} value={scopeFilter}>
            <SelectTrigger aria-label="Scope" className="w-[170px] border-border/50 bg-muted/50">
              <SelectValue placeholder="Scope" />
            </SelectTrigger>
            <SelectContent>{scopeItems}</SelectContent>
          </Select>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 rounded-md border border-border/30 bg-muted/30 px-3 py-1.5">
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

          <div className="flex items-center gap-2 rounded-md border border-border/30 bg-muted/30 px-3 py-1.5">
            <Switch
              checked={wrapLines}
              className="scale-90"
              id="log-viewer-wrap"
              onCheckedChange={onWrapLinesChange}
            />
            <Label className="cursor-pointer font-medium text-xs" htmlFor="log-viewer-wrap">
              Wrap lines
            </Label>
          </div>

          <div className="flex items-center gap-2 rounded-md border border-border/30 bg-muted/30 px-3 py-1.5">
            <Switch
              checked={sortNewestFirst}
              className="scale-90"
              id="log-viewer-sort"
              onCheckedChange={onSortNewestFirstChange}
            />
            <Label className="cursor-pointer font-medium text-xs" htmlFor="log-viewer-sort">
              Newest first
            </Label>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button className="h-9 gap-2 bg-muted/30" size="sm" variant="outline">
                <Settings2 className="h-3.5 w-3.5" />
                View
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
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
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="mx-1 hidden h-4 w-px bg-border/50 sm:block" />

          <Button
            aria-label="Refresh Logs"
            className="h-9 w-9"
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
            className="h-9 w-9"
            disabled={rowsCount === 0}
            onClick={onExport}
            size="icon"
            title="Export Logs"
            variant="ghost"
          >
            <Download className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-muted-foreground text-xs">
        <div className="flex items-center gap-2">
          <Label className="text-xs" htmlFor="log-viewer-retention">
            Retention
          </Label>
          <Select
            onValueChange={(value) => onRetentionChange(Number(value))}
            value={String(retentionLimit)}
          >
            <SelectTrigger
              className="h-8 w-[140px] border-border/50 bg-muted/40"
              id="log-viewer-retention"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>{retentionItems}</SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <Label className="text-xs" htmlFor="log-viewer-page-size">
            Page size
          </Label>
          <Select
            onValueChange={(value) => onPageSizeChange(Number(value))}
            value={String(pageSize)}
          >
            <SelectTrigger
              className="h-8 w-[120px] border-border/50 bg-muted/40"
              id="log-viewer-page-size"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>{pageSizeItems}</SelectContent>
          </Select>
        </div>
        <div className="text-muted-foreground text-xs">
          {rowsCount === 0 ? 'No matching logs' : `${rowsCount} matching logs`}
        </div>
      </div>
      {diagnosticFilters}
    </div>
  );
}
