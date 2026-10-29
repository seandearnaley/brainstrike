import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import { useAssistantThreadStore, WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data';
import { Button, Input } from '@brainstrike/ui';
import { getErrorMessage } from '@brainstrike/utils/error-utils';
import { Search, Shapes } from 'lucide-react';
import { type ReactElement, type ReactNode, useEffect, useMemo, useState } from 'react';
import {
  type AssistantThreadHostArtifact,
  type AssistantThreadHostArtifacts,
  useAssistantThreadHost,
} from '../assistant-thread-host-context';
import { canvasWorkspaceTabId } from '../canvas/canvas-workspace-tab';
import { threadWorkspaceNavigation } from '../thread-workspace/live-thread-workspace-navigation';
import { formatWorktreeActivity } from '../worktree-map/worktree-map-model';
import { ArtifactCard } from './artifact-card';

type ArtifactList =
  | { readonly status: 'loading' }
  | { readonly error: string; readonly status: 'error' }
  | { readonly artifacts: readonly AssistantThreadHostArtifact[]; readonly status: 'ready' };

/**
 * Opens an artifact where it lives: the shell returns to the workspace, the
 * artifact's top-level thread becomes active, and once that thread's saved
 * workspace is applied the canvas opens in a tab of its own.
 */
function openArtifact(artifact: AssistantThreadHostArtifact): void {
  usePanelLayoutStore.getState().setActiveTab('explorer');
  threadWorkspaceNavigation.open(
    WORKSPACE_MEMORY_RESOURCE_ID,
    artifact.rootThreadId,
    canvasWorkspaceTabId({ canvasId: artifact.canvasId, threadId: artifact.threadId })
  );
}

/**
 * The list, read whenever the page is shown and whenever a run commits a
 * canvas while it is. A failed read stays an error, never an empty gallery.
 */
function useArtifactList(artifacts: AssistantThreadHostArtifacts, shown: boolean): ArtifactList {
  const host = useAssistantThreadHost();
  const [list, setList] = useState<ArtifactList>({ status: 'loading' });
  const [generation, setGeneration] = useState(0);
  useEffect(
    () =>
      shown ? host?.subscribeCanvasCommits?.(() => setGeneration((value) => value + 1)) : undefined,
    [host, shown]
  );
  useEffect(() => {
    if (!shown) {
      return;
    }
    let cancelled = false;
    artifacts.list().then(
      (listed) => {
        if (!cancelled) {
          setList({ artifacts: listed, status: 'ready' });
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setList({ error: getErrorMessage(error), status: 'error' });
        }
      }
    );
    return () => {
      cancelled = true;
    };
  }, [artifacts, generation, shown]);
  return list;
}

function GalleryNotice({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      {children}
    </div>
  );
}

function ArtifactsGallery({
  artifacts,
  shellSrc,
}: {
  readonly artifacts: AssistantThreadHostArtifacts;
  readonly shellSrc: string;
}): ReactElement {
  const shown = usePanelLayoutStore((state) => state.activeTab === 'artifacts');
  const list = useArtifactList(artifacts, shown);
  const threads = useAssistantThreadStore(
    (state) => state.threadsByResourceId[WORKSPACE_MEMORY_RESOURCE_ID]
  );
  const [query, setQuery] = useState('');
  const threadTitles = useMemo(
    () => new Map((threads ?? []).map((thread) => [thread.id, thread.title.trim()])),
    [threads]
  );
  const threadLabel = (artifact: AssistantThreadHostArtifact): string => {
    const title = threadTitles.get(artifact.rootThreadId) || 'Untitled thread';
    return artifact.threadId === artifact.rootThreadId ? title : `${title} · subagent`;
  };
  const needle = query.trim().toLowerCase();
  const visible =
    list.status === 'ready'
      ? list.artifacts.filter(
          (artifact) =>
            needle === '' ||
            artifact.title.toLowerCase().includes(needle) ||
            threadLabel(artifact).toLowerCase().includes(needle)
        )
      : [];
  const now = new Date();

  let body: ReactElement;
  if (list.status === 'loading') {
    body = (
      <GalleryNotice>
        <p className="text-muted-foreground text-sm" role="status">
          Loading artifacts…
        </p>
      </GalleryNotice>
    );
  } else if (list.status === 'error') {
    body = (
      <GalleryNotice>
        <p className="text-destructive max-w-md text-sm" data-testid="artifacts-error" role="alert">
          Artifacts could not be listed: {list.error}
        </p>
      </GalleryNotice>
    );
  } else if (list.artifacts.length === 0) {
    body = (
      <GalleryNotice>
        <Shapes aria-hidden="true" className="text-muted-foreground/60 size-10" />
        <p className="text-foreground text-sm font-medium">No artifacts yet</p>
        <p className="text-muted-foreground max-w-sm text-sm">
          When the assistant makes a canvas in any thread, it is saved here so you can find it
          again.
        </p>
      </GalleryNotice>
    );
  } else if (visible.length === 0) {
    body = (
      <GalleryNotice>
        <p className="text-muted-foreground text-sm" role="status">
          No artifacts match “{query.trim()}”.
        </p>
        <Button onClick={() => setQuery('')} size="sm" variant="outline">
          Clear search
        </Button>
      </GalleryNotice>
    );
  } else {
    body = (
      <ul
        aria-label="Artifacts"
        className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-4 p-6"
        data-testid="artifacts-grid"
      >
        {visible.map((artifact) => (
          <ArtifactCard
            artifact={artifact}
            artifacts={artifacts}
            key={`${artifact.threadId}\n${artifact.canvasId}`}
            onOpen={openArtifact}
            shellSrc={shellSrc}
            threadLabel={threadLabel(artifact)}
            updatedLabel={formatWorktreeActivity(new Date(artifact.updatedAt), now)}
          />
        ))}
      </ul>
    );
  }

  return (
    <div className="bg-background flex h-full min-h-0 flex-col" data-testid="artifacts-page">
      <header className="border-border flex shrink-0 flex-wrap items-center gap-3 border-b px-6 py-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-foreground text-base font-semibold">Artifacts</h1>
          <p className="text-muted-foreground text-xs">
            {list.status === 'ready'
              ? `${list.artifacts.length} ${list.artifacts.length === 1 ? 'canvas' : 'canvases'} from your threads`
              : 'Canvases from your threads'}
          </p>
        </div>
        <div className="relative w-64 max-w-full">
          <Search
            aria-hidden="true"
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2"
          />
          <Input
            aria-label="Search artifacts"
            className="h-8 pl-7 text-sm"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search artifacts"
            type="search"
            value={query}
          />
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">{body}</div>
    </div>
  );
}

/**
 * The Artifacts gallery: every canvas the agent host's threads hold, newest
 * first, as a searchable grid of live previews. Artifacts live with their
 * thread (the run log is their only record), so a deleted thread's artifacts
 * leave the gallery with it. A host without canvases has no gallery.
 */
export function ArtifactsPage({ shellSrc }: { readonly shellSrc: string }): ReactElement {
  const host = useAssistantThreadHost();
  if (!host?.artifacts) {
    return (
      <GalleryNotice>
        <p className="text-muted-foreground text-sm" role="status">
          Artifacts are unavailable until the agent host is connected.
        </p>
      </GalleryNotice>
    );
  }
  return <ArtifactsGallery artifacts={host.artifacts} shellSrc={shellSrc} />;
}
