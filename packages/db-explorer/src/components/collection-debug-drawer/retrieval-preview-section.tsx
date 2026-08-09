/**
 * Retrieval tuning + one-shot scored search preview.
 *
 * This is the surface that shows SCORES — the affordance Workspace Search
 * deliberately lacks. It reuses the preserved `SearchConfigPanel` for tuning
 * and the surviving `useSemanticSearchExecutor` for the actual retrieval, and
 * it runs exactly once per explicit submit.
 */

import type { ContextTarget } from '@brainstrike/context-actions';
import {
  Button,
  DEFAULT_SEARCH_CONFIG,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  type SearchConfig,
  SearchConfigPanel,
  type SemanticSearchResult,
} from '@brainstrike/ui';
import { AlertTriangle, Search, Settings2 } from 'lucide-react';
import { type FormEvent, useCallback, useState } from 'react';
import { useSemanticSearchExecutor } from '../../hooks/use-semantic-search-executor';
import {
  canUseCollectionForRetrievalPreview,
  formatSimilarityScore,
  getRetrievalDisabledReason,
} from './drawer-model';
import { DrawerSection } from './drawer-primitives';
import type { CollectionDebugDrawerProps } from './drawer-props';
import { chunkRowToTarget } from './drawer-targets';
import { openRowContextMenu } from './open-row-context-menu';

type ClaimTarget = (target: ContextTarget, element: HTMLElement) => void;

interface RetrievalPreviewSectionProps
  extends Pick<
    CollectionDebugDrawerProps,
    'activeCollectionId' | 'activeCollectionSystemRole' | 'chunkRepository' | 'fileRepository'
  > {
  readonly onClaimTarget: ClaimTarget;
}

export function RetrievalPreviewSection({
  activeCollectionId,
  activeCollectionSystemRole,
  chunkRepository,
  fileRepository,
  onClaimTarget,
}: RetrievalPreviewSectionProps) {
  const [query, setQuery] = useState('');
  const [config, setConfig] = useState<SearchConfig>(DEFAULT_SEARCH_CONFIG);
  const [results, setResults] = useState<readonly SemanticSearchResult[] | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const executor = useSemanticSearchExecutor({ chunkRepository, fileRepository });

  const gateReason = getRetrievalDisabledReason(activeCollectionId, activeCollectionSystemRole);
  const allowed = canUseCollectionForRetrievalPreview(
    activeCollectionId,
    activeCollectionSystemRole
  );
  // A missing executor is its own visible reason — never a silently dead button.
  const refusal =
    gateReason ??
    (executor
      ? null
      : 'The chunk and file repositories are not available, so retrieval cannot run.');

  const handleSubmit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      const trimmed = query.trim();
      if (!(allowed && executor) || trimmed.length === 0) {
        return;
      }
      setRunning(true);
      setError(null);
      executor(trimmed, config, activeCollectionId)
        .then((next) => {
          setResults(next);
        })
        .catch((cause: unknown) => {
          setResults(null);
          setError(cause instanceof Error ? cause.message : String(cause));
        })
        .finally(() => setRunning(false));
    },
    [activeCollectionId, allowed, config, executor, query]
  );

  return (
    <DrawerSection
      subtitle={config.retrievalMode === 'hybrid' ? 'Hybrid (RRF)' : 'Vector only'}
      testId="collection-debug-retrieval"
      title="Retrieval preview"
    >
      {refusal ? (
        <div
          className="flex items-start gap-1.5 rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-amber-700 text-xs dark:text-amber-400"
          data-testid="collection-debug-retrieval-refusal"
          role="alert"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>{refusal}</span>
        </div>
      ) : null}

      <form className="mt-1 flex items-center gap-1.5" onSubmit={handleSubmit}>
        <Input
          aria-label="Retrieval preview query"
          className="h-7 flex-1 text-xs"
          disabled={refusal !== null}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Query this collection…"
          value={query}
        />
        <Popover>
          <PopoverTrigger asChild>
            <Button
              aria-label="Retrieval settings"
              className="size-7 p-0"
              size="sm"
              variant="ghost"
            >
              <Settings2 className="size-3.5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72 p-3">
            <SearchConfigPanel config={config} onConfigChange={setConfig} />
          </PopoverContent>
        </Popover>
        <Button
          className="h-7 gap-1 px-2 text-xs"
          disabled={refusal !== null || running || query.trim().length === 0}
          size="sm"
          type="submit"
          variant="secondary"
        >
          <Search className="size-3.5" />
          {running ? 'Running…' : 'Run'}
        </Button>
      </form>

      {error ? (
        <div
          className="mt-1.5 flex items-start gap-1.5 text-destructive text-xs"
          data-testid="collection-debug-retrieval-error"
          role="alert"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="break-all">{error}</span>
        </div>
      ) : null}

      {results ? (
        <ol className="mt-2 space-y-1" data-testid="collection-debug-retrieval-results">
          {results.length === 0 ? (
            <li className="px-2 py-1 text-muted-foreground text-xs">
              No chunks scored above the current threshold.
            </li>
          ) : null}
          {results.map((result) => {
            const score = formatSimilarityScore(result.similarity);
            return (
              <li key={result.chunkId}>
                {/* Enter and click open this row's context menu — see the
                    equivalent note in failed-embeddings-section. */}
                <button
                  className="flex w-full items-start gap-2 rounded px-2 py-1 text-left text-xs hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  onClick={(event) => openRowContextMenu(event.currentTarget)}
                  onContextMenu={(event) =>
                    onClaimTarget(
                      chunkRowToTarget({ content: result.content, id: result.chunkId }),
                      event.currentTarget
                    )
                  }
                  type="button"
                >
                  <span className="shrink-0 font-mono text-[10px] text-primary tabular-nums">
                    <span aria-hidden="true">{score.label}</span>
                    <span className="sr-only">{score.textEquivalent}</span>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{result.fileName}</span>
                    <span className="block truncate text-muted-foreground">
                      {result.content.slice(0, 120)}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      ) : null}
    </DrawerSection>
  );
}
