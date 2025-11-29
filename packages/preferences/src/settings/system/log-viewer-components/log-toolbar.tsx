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

interface LogToolbarProps {
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
}

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
    <div className="flex flex-col gap-4 border-b border-border/40 bg-background/95 p-4 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-1 items-center gap-4">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search logs..."
              value={globalFilter}
              onChange={(event) => onSearchChange(event.target.value)}
              className="pl-9 bg-muted/50 border-border/50 focus:bg-background transition-colors"
            />
          </div>
          <Select
            value={logLevelFilter}
            onValueChange={(value) => onLevelChange(value as LogLevel)}
          >
            <SelectTrigger className="w-[140px] bg-muted/50 border-border/50">
              <SelectValue placeholder="Level" />
            </SelectTrigger>
            <SelectContent>{logLevelItems}</SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-muted/30 border border-border/30">
            <Switch
              id="log-viewer-autoscroll"
              checked={autoScroll}
              onCheckedChange={onAutoScrollChange}
              className="scale-90"
            />
            <Label htmlFor="log-viewer-autoscroll" className="text-xs font-medium cursor-pointer">
              Auto-scroll
            </Label>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-9 gap-2 bg-muted/30">
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
                    key={column.id}
                    checked={column.getIsVisible()}
                    onCheckedChange={(value) => column.toggleVisibility(!!value)}
                  >
                    {column.id.charAt(0).toUpperCase() + column.id.slice(1)}
                  </DropdownMenuCheckboxItem>
                ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="h-4 w-px bg-border/50 mx-1" />

          <Button
            variant="ghost"
            size="icon"
            onClick={onRefresh}
            disabled={logsLoading || !canRefresh}
            className="h-9 w-9"
            title="Refresh Logs"
          >
            <RefreshCw className={`h-4 w-4 ${logsLoading ? 'animate-spin' : ''}`} />
          </Button>

          <Button
            variant="ghost"
            size="icon"
            onClick={onExport}
            disabled={rowsCount === 0}
            className="h-9 w-9"
            title="Export Logs"
          >
            <Download className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
