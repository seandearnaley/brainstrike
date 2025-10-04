import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@brainstrike/ui';
import { Brain, Database, MessageCircle, Search } from 'lucide-react';
import React, { lazy, useEffect, useState } from 'react';
import { EmbeddingsPanel } from './embeddings-panel';
import { McpBanner } from './mcp-banner';
import { type DbSubtab, dbPanelSelectors, useDbPanelStore } from './stores/db-panel-store';
import {
  type RightPanelTab,
  rightPanelSelectors,
  useRightPanelStore,
} from './stores/right-panel-store';
import { searchPanelSelectors, useSearchPanelStore } from './stores/search-panel-store';

// Lazy-load heavy components for code splitting
const DatabaseTab = lazy(async () => ({
  default: (await import('./database-tab-chunk')).DatabaseTab,
}));

const AssistantUiPanelLazy = lazy(async () => ({
  default: (await import('./assistant-ui-panel-wrapper')).AssistantUiPanelWrapper,
}));

export function RightPanel() {
  const activeTab = useRightPanelStore(rightPanelSelectors.activeTab);
  const setActiveTab = useRightPanelStore((s) => s.setActiveTab);
  // Unconditional hooks for DB logs controls (selector tuples to keep shape stable)
  const filterText = useDbPanelStore(dbPanelSelectors.filter);
  const [dbSortBy, dbSortDir] = useDbPanelStore(dbPanelSelectors.sorting);
  const [dbPage, dbPageSize] = useDbPanelStore(dbPanelSelectors.paging);
  const setDbFilterText = useDbPanelStore((s) => s.setFilterText);
  const setDbSort = useDbPanelStore((s) => s.setSort);
  const setDbPage = useDbPanelStore((s) => s.setPage);
  const setDbPageSize = useDbPanelStore((s) => s.setPageSize);
  const activeSubtab = useDbPanelStore(dbPanelSelectors.activeSubtab);
  const setActiveSubtab = useDbPanelStore((s) => s.setActiveSubtab);

  // Search panel filters as stable tuple + actions
  const [query, regex, caseSensitive, wholeWord] = useSearchPanelStore(
    searchPanelSelectors.queryAndFlags
  );
  const setQuery = useSearchPanelStore((s) => s.setQuery);
  const toggleRegex = useSearchPanelStore((s) => s.toggleRegex);
  const toggleCaseSensitive = useSearchPanelStore((s) => s.toggleCaseSensitive);
  const toggleWholeWord = useSearchPanelStore((s) => s.toggleWholeWord);
  return (
    <div className="h-full flex flex-col">
      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab((v as RightPanelTab) ?? 'assistant')}
        className="flex-1 flex flex-col min-h-0"
      >
        <TabsList className="grid grid-cols-4 mx-2 mt-2 mb-2 flex-shrink-0">
          <TabsTrigger value="assistant" className="flex items-center gap-1">
            <MessageCircle className="h-3 w-3" />
            <span className="hidden sm:inline">Assistant</span>
          </TabsTrigger>
          <TabsTrigger value="embeddings" className="flex items-center gap-1">
            <Brain className="h-3 w-3" />
            <span className="hidden sm:inline">Embed</span>
          </TabsTrigger>
          <TabsTrigger value="search" className="flex items-center gap-1">
            <Search className="h-3 w-3" />
            <span className="hidden sm:inline">Search</span>
          </TabsTrigger>
          <TabsTrigger value="database" className="flex items-center gap-1">
            <Database className="h-3 w-3" />
            <span className="hidden sm:inline">DB</span>
          </TabsTrigger>
        </TabsList>

        <div className="flex-1 px-2 flex flex-col min-h-0">
          <TabsContent
            value="assistant"
            forceMount
            className="flex-1 min-h-0 data-[state=inactive]:hidden flex flex-col"
          >
            <AssistantChatCard />
          </TabsContent>

          <TabsContent value="embeddings" className="flex-1 mt-0 overflow-y-auto min-h-0">
            <EmbeddingsPanel />
          </TabsContent>

          <TabsContent value="search" className="flex-1 mt-0 overflow-y-auto min-h-0">
            <Card className="h-full">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Search</CardTitle>
                <CardDescription className="text-xs">
                  Search and replace functionality
                </CardDescription>
              </CardHeader>
              <CardContent className="text-xs space-y-3">
                {/* Persisted search form */}
                <div className="grid grid-cols-1 gap-2">
                  <div className="space-y-1">
                    <Label className="text-xs" htmlFor="rp-search-query">
                      Query
                    </Label>
                    <Input
                      id="rp-search-query"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      className="text-xs"
                      placeholder="Search..."
                    />
                  </div>
                  <div className="flex items-center gap-3">
                    <label className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        className="h-3 w-3"
                        checked={regex}
                        onChange={toggleRegex}
                      />
                      <span>Regex</span>
                    </label>
                    <label className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        className="h-3 w-3"
                        checked={caseSensitive}
                        onChange={toggleCaseSensitive}
                      />
                      <span>Case</span>
                    </label>
                    <label className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        className="h-3 w-3"
                        checked={wholeWord}
                        onChange={toggleWholeWord}
                      />
                      <span>Whole word</span>
                    </label>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="database" className="flex-1 mt-0 overflow-y-auto min-h-0">
            <div className="flex items-center gap-2 px-2">
              <Label className="text-[11px]">View</Label>
              <select
                className="h-7 text-[11px] border rounded px-1"
                aria-label="DB subtab"
                value={activeSubtab}
                onChange={(e) => setActiveSubtab(e.target.value as DbSubtab)}
              >
                <option value="overview">Overview</option>
                <option value="logs">Logs</option>
                <option value="config">Config</option>
              </select>
            </div>
            {activeSubtab === 'overview' && (
              <React.Suspense
                fallback={<div className="text-xs opacity-70 px-2">Loading DB UI…</div>}
              >
                <DatabaseTab />
              </React.Suspense>
            )}
            {activeSubtab === 'logs' && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Logs</CardTitle>
                  <CardDescription className="text-xs">
                    Recent database/queue events
                  </CardDescription>
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
                        onChange={(e) => setDbFilterText(e.target.value)}
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
                        onChange={(e) => setDbSort(e.target.value || null, dbSortDir)}
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
                        onChange={(e) =>
                          setDbSort(dbSortBy ?? null, e.target.value as 'asc' | 'desc')
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
                        onChange={(e) => setDbPage(Number(e.target.value) || 1)}
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
                        onChange={(e) => setDbPageSize(Number(e.target.value) || 10)}
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
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}

type AssistantAvailabilityState =
  | { state: 'loading' }
  | { state: 'enabled' }
  | { state: 'disabled'; reason?: string }
  | { state: 'error'; message: string };

function AssistantChatCard() {
  const status = useAssistantAvailability();

  return (
    <Card className="flex flex-col h-full overflow-hidden" data-testid="assistant-chat-card">
      <CardHeader className="flex-shrink-0 pb-3">
        <CardTitle className="text-sm">Assistant</CardTitle>
        <CardDescription className="text-xs">
          Chat with the Brainstrike assistant for guidance while editing props.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex-1 min-h-0 p-0 flex flex-col">
        {status.state === 'loading' && (
          <div className="p-4 text-xs opacity-70">Checking assistant availability…</div>
        )}
        {status.state === 'error' && (
          <div className="p-4">
            <AssistantStatusCallout
              title="Assistant unavailable"
              description="Could not determine assistant status."
              detail={status.message}
              variant="error"
            />
          </div>
        )}
        {status.state === 'disabled' && (
          <div className="p-4">
            <AssistantStatusCallout
              title="Assistant disabled"
              description="Add an OpenAI API key in Settings → LLM Provider Keys to enable the assistant."
              variant="warning"
              {...(status.reason ? { detail: `Reason: ${status.reason}` } : {})}
            />
          </div>
        )}
        {status.state === 'enabled' && (
          <>
            <div className="px-4 pb-2">
              <McpBanner />
            </div>
            <React.Suspense
              fallback={<div className="p-4 text-xs opacity-70">Loading assistant…</div>}
            >
              <AssistantUiPanelLazy />
            </React.Suspense>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function useAssistantAvailability(): AssistantAvailabilityState {
  const [state, setState] = useState<AssistantAvailabilityState>({ state: 'loading' });

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    fetchAssistantStatusState(controller.signal)
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch((error) => {
        if (cancelled) return;
        if ((error as { name?: string })?.name === 'AbortError') return;
        setState({
          state: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  return state;
}

async function resolveAssistantStatusUrl(): Promise<string> {
  if (typeof window === 'undefined') return '/api/assistant/status';

  type AssistantBridge = {
    url?: string;
    getUrl?: () => Promise<string>;
  };

  const assistantBridge = (window as unknown as { assistant?: AssistantBridge }).assistant;

  if (assistantBridge) {
    if (typeof assistantBridge.getUrl === 'function') {
      try {
        const base = await assistantBridge.getUrl();
        if (base) {
          return `${trimTrailingSlash(base)}/assistant/status`;
        }
      } catch {}
    }

    if (typeof assistantBridge.url === 'string' && assistantBridge.url.length > 0) {
      return `${trimTrailingSlash(assistantBridge.url)}/assistant/status`;
    }
  }

  return '/api/assistant/status';
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

async function fetchAssistantStatusState(signal: AbortSignal): Promise<AssistantAvailabilityState> {
  const url = await resolveAssistantStatusUrl();
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    signal,
  });
  if (!res.ok) {
    throw new Error(`status ${res.status}`);
  }
  const payload = (await res.json()) as { enabled: boolean; reason?: string };
  if (payload.enabled) {
    return { state: 'enabled' };
  }
  if (payload.reason) {
    return { state: 'disabled', reason: payload.reason };
  }
  return { state: 'disabled' };
}

function AssistantStatusCallout({
  title,
  description,
  detail,
  variant,
}: {
  title: string;
  description: string;
  detail?: string;
  variant: 'warning' | 'error';
}) {
  const tone =
    variant === 'error'
      ? 'border-destructive/50 text-destructive'
      : 'border-muted-foreground/40 text-muted-foreground';
  return (
    <div
      className={`rounded-md border border-dashed p-3 text-xs leading-relaxed ${tone}`}
      data-testid="assistant-status-callout"
    >
      <div className="font-medium">{title}</div>
      <div className="mt-1">{description}</div>
      {detail ? <div className="mt-1 text-[11px] opacity-80">{detail}</div> : null}
    </div>
  );
}
