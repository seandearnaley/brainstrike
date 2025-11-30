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
import type { LogLevel } from '@brainstrike/utils';
import type { Table as ReactTableInstance } from '@tanstack/react-table';
import { Download, RefreshCw, Search, Settings2 } from 'lucide-react';
import type { ReactNode } from 'react';
import type { LogRecordRow } from './log-utils';

type LogToolbarProps = {
  logLevelFilter: LogLevel;
  onLevelChange: (value: LogLevel) => void;
  logLevelItems: ReactNode;
  globalFilter: string;
  onSearchChange: (value: string) => void;
  autoScroll: boolean;
  onAutoScrollChange: (value: boolean) => void;
  table: ReactTableInstance<LogRecordRow>;
  rowsCount: number;
  logsLoading: boolean;
  onExport: () => void;
  onRefresh: () => void;
  canRefresh: boolean;
};

export function LogToolbar({
  logLevelFilter,
  onLevelChange,
  logLevelItems,
  globalFilter,
  onSearchChange,
  autoScroll,
  onAutoScrollChange,
  table,
  rowsCount,
  logsLoading,
  onExport,
  onRefresh,
  canRefresh,
}: LogToolbarProps) {
  return (
    <div className="flex flex-col gap-4 border-border/40 border-b bg-background/95 p-4 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-1 items-center gap-4">
          <div className="relative max-w-md flex-1">
            <Search className="absolute top-2.5 left-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              className="border-border/50 bg-muted/50 pl-9 transition-colors focus:bg-background"
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="Search logs..."
              value={globalFilter}
            />
          </div>
          <Select
            onValueChange={(value) => onLevelChange(value as LogLevel)}
            value={logLevelFilter}
          >
            <SelectTrigger className="w-[140px] border-border/50 bg-muted/50">
              <SelectValue placeholder="Level" />
            </SelectTrigger>
            <SelectContent>{logLevelItems}</SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-3">
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

          <div className="mx-1 h-4 w-px bg-border/50" />

          <Button
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
    </div>
  );
}
