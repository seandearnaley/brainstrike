import type { QueueAdapter } from '@brainstrike/queue';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '@brainstrike/ui';
import React, { lazy, type ReactElement } from 'react';
import { type DbSubtab, dbPanelSelectors, useDbPanelStore } from './stores/db-panel-store';

const DatabaseTabChunk = lazy(async () => ({
  default: (await import('./database-tab-chunk')).DatabaseTab,
}));

interface DatabaseTabProps {
  readonly embeddingQueue?: QueueAdapter | null;
}

export function DatabaseTab({ embeddingQueue = null }: DatabaseTabProps): ReactElement {
  const filterText = useDbPanelStore(dbPanelSelectors.filter);
  const [dbSortBy, dbSortDir] = useDbPanelStore(dbPanelSelectors.sorting);
  const [dbPage, dbPageSize] = useDbPanelStore(dbPanelSelectors.paging);
  const setDbFilterText = useDbPanelStore((state) => state.setFilterText);
  const setDbSort = useDbPanelStore((state) => state.setSort);
  const setDbPage = useDbPanelStore((state) => state.setPage);
  const setDbPageSize = useDbPanelStore((state) => state.setPageSize);
  const activeSubtab = useDbPanelStore(dbPanelSelectors.activeSubtab);
  const setActiveSubtab = useDbPanelStore((state) => state.setActiveSubtab);

  return (
    <>
      <div className="flex items-center gap-2 px-2">
        <Label className="text-[11px]">View</Label>
        <select
          className="h-7 text-[11px] border rounded px-1"
          aria-label="DB subtab"
          value={activeSubtab}
          onChange={(event) => setActiveSubtab(event.target.value as DbSubtab)}
        >
          <option value="overview">Overview</option>
          <option value="logs">Logs</option>
          <option value="config">Config</option>
        </select>
      </div>
      {activeSubtab === 'overview' && (
        <React.Suspense fallback={<div className="text-xs opacity-70 px-2">Loading DB UI…</div>}>
          <DatabaseTabChunk embeddingQueue={embeddingQueue} />
        </React.Suspense>
      )}
      {activeSubtab === 'logs' && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Logs</CardTitle>
            <CardDescription className="text-xs">Recent database/queue events</CardDescription>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-[11px]" htmlFor="db-logs-filter">
                  Filter
                </Label>
                <Input
                  id="db-logs-filter"
                  className="h-7 text-[11px]"
                  value={filterText}
                  onChange={(event) => setDbFilterText(event.target.value)}
                  placeholder="e.g., embeddings"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-[11px]" htmlFor="db-logs-sortby">
                  Sort By
                </Label>
                <Input
                  id="db-logs-sortby"
                  className="h-7 text-[11px]"
                  value={dbSortBy ?? ''}
                  onChange={(event) => setDbSort(event.target.value || null, dbSortDir)}
                  placeholder="column name"
                />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div className="space-y-1">
                <Label className="text-[11px]" htmlFor="db-logs-dir">
                  Direction
                </Label>
                <select
                  id="db-logs-dir"
                  className="h-7 text-[11px] border rounded px-1"
                  value={dbSortDir}
                  onChange={(event) =>
                    setDbSort(dbSortBy ?? null, event.target.value as 'asc' | 'desc')
                  }
                >
                  <option value="asc">asc</option>
                  <option value="desc">desc</option>
                </select>
              </div>
              <div className="space-y-1">
                <Label className="text-[11px]" htmlFor="db-logs-page">
                  Page
                </Label>
                <Input
                  id="db-logs-page"
                  type="number"
                  className="h-7 text-[11px]"
                  value={dbPage}
                  onChange={(event) => setDbPage(Number(event.target.value) || 1)}
                  min={1}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-[11px]" htmlFor="db-logs-pagesize">
                  Page Size
                </Label>
                <Input
                  id="db-logs-pagesize"
                  type="number"
                  className="h-7 text-[11px]"
                  value={dbPageSize}
                  onChange={(event) => setDbPageSize(Number(event.target.value) || 10)}
                  min={1}
                />
              </div>
            </div>
            <div>Database is initializing...</div>
          </CardContent>
        </Card>
      )}
      {activeSubtab === 'config' && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Config</CardTitle>
            <CardDescription className="text-xs">Connection and tuning</CardDescription>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Database is initializing...
          </CardContent>
        </Card>
      )}
    </>
  );
}
