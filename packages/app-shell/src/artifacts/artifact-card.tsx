import {
  type AnyContextAction,
  defineContextAction,
  type TargetOf,
} from '@brainstrike/context-actions';
import { ActionContextMenu, Button, saveDownload, useContextMenuTarget } from '@brainstrike/ui';
import { Download, MessageSquare, SquareArrowOutUpRight } from 'lucide-react';
import type { ReactElement } from 'react';
import type {
  AssistantThreadHostArtifact,
  AssistantThreadHostArtifacts,
} from '../assistant-thread-host-context';
import { canvasHtmlFile } from '../canvas/download-canvas-html';
import { ArtifactThumbnail } from './artifact-thumbnail';

/** Saves the artifact's latest version; `saveDownload` toasts the saved path or the failure. */
function download(
  artifacts: AssistantThreadHostArtifacts,
  artifact: AssistantThreadHostArtifact
): Promise<boolean> {
  return saveDownload({
    build: async () => {
      const canvas = await artifacts.read(artifact.threadId, artifact.canvasId);
      if (!canvas) {
        throw new Error('This artifact is no longer in its thread.');
      }
      return canvasHtmlFile(canvas);
    },
    what: 'artifact',
  });
}

function artifactTarget(
  artifact: AssistantThreadHostArtifact,
  title: string
): TargetOf<'artifact'> {
  return {
    canvasId: artifact.canvasId,
    kind: 'artifact',
    rootThreadId: artifact.rootThreadId,
    threadId: artifact.threadId,
    title,
  };
}

/**
 * The card's right-click actions. Each one checks that the claimed target is
 * still this card's artifact before it acts.
 */
function artifactActions({
  artifact,
  artifacts,
  onOpen,
  onOpenThread,
}: {
  readonly artifact: AssistantThreadHostArtifact;
  readonly artifacts: AssistantThreadHostArtifacts;
  readonly onOpen: (artifact: AssistantThreadHostArtifact) => void;
  readonly onOpenThread: (artifact: AssistantThreadHostArtifact) => void;
}): readonly AnyContextAction[] {
  const isThisArtifact = (target: TargetOf<'artifact'>): boolean =>
    target.canvasId === artifact.canvasId && target.threadId === artifact.threadId;
  const stale = { error: 'This artifact card is no longer available', ok: false as const };
  return [
    defineContextAction({
      appliesTo: ['artifact'] as const,
      group: 'primary',
      icon: SquareArrowOutUpRight,
      id: 'artifact.open',
      label: 'Open',
      run: (target) => {
        if (!isThisArtifact(target)) {
          return Promise.resolve(stale);
        }
        onOpen(artifact);
        return Promise.resolve({ ok: true });
      },
    }),
    defineContextAction({
      appliesTo: ['artifact'] as const,
      group: 'primary',
      icon: MessageSquare,
      id: 'artifact.open-thread',
      label: 'Open thread',
      run: (target) => {
        if (!isThisArtifact(target)) {
          return Promise.resolve(stale);
        }
        onOpenThread(artifact);
        return Promise.resolve({ ok: true });
      },
    }),
    defineContextAction({
      appliesTo: ['artifact'] as const,
      group: 'primary',
      icon: Download,
      id: 'artifact.download',
      label: 'Download HTML',
      run: async (target) => {
        if (!isThisArtifact(target)) {
          return stale;
        }
        // A failed save is already reported by saveDownload's toast.
        await download(artifacts, artifact);
        return { ok: true };
      },
    }),
  ];
}

/**
 * One artifact in the gallery: its live preview, title, the thread it lives
 * in and when it last changed. The card opens it in its thread; the download
 * button saves its latest version as an HTML file. Right-click offers Open,
 * Open thread and Download HTML.
 */
export function ArtifactCard({
  artifact,
  artifacts,
  onOpen,
  onOpenThread,
  shellSrc,
  threadLabel,
  updatedLabel,
}: {
  readonly artifact: AssistantThreadHostArtifact;
  readonly artifacts: AssistantThreadHostArtifacts;
  readonly onOpen: (artifact: AssistantThreadHostArtifact) => void;
  readonly onOpenThread: (artifact: AssistantThreadHostArtifact) => void;
  readonly shellSrc: string;
  readonly threadLabel: string;
  readonly updatedLabel: string;
}): ReactElement {
  const title = artifact.title.trim() || 'Untitled canvas';
  const contextMenu = useContextMenuTarget();
  const { setTarget } = contextMenu;
  return (
    <li className="group relative">
      <ActionContextMenu
        controller={contextMenu}
        localActions={artifactActions({ artifact, artifacts, onOpen, onOpenThread })}
      >
        {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: layout-neutral wrapper claims this card's artifact as the context target */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: layout-neutral wrapper delegates all activation to the menu */}
        <div
          className="contents"
          onContextMenu={() => setTarget(artifactTarget(artifact, title))}
          onContextMenuCapture={() => setTarget(null)}
        >
          <button
            className="border-border bg-card hover:border-primary/40 focus-visible:ring-ring flex w-full flex-col overflow-hidden rounded-lg border text-left transition-colors focus-visible:ring-2 focus-visible:outline-hidden motion-reduce:transition-none"
            data-testid="artifact-card"
            onClick={() => onOpen(artifact)}
            title={`Open ${title} in its thread`}
            type="button"
          >
            <ArtifactThumbnail
              artifacts={artifacts}
              canvasId={artifact.canvasId}
              shellSrc={shellSrc}
              threadId={artifact.threadId}
              version={artifact.version}
            />
            <span className="border-border flex min-w-0 flex-col gap-0.5 border-t px-3 py-2">
              <span className="text-foreground truncate text-sm font-medium" title={title}>
                {title}
              </span>
              <span className="text-muted-foreground truncate text-xs" title={threadLabel}>
                {threadLabel}
              </span>
              <span className="text-muted-foreground truncate text-xs tabular-nums">
                v{artifact.version} · {updatedLabel}
              </span>
            </span>
          </button>
          {/* Shown on hover and whenever keyboard focus is anywhere in the card. */}
          <Button
            aria-label={`Download ${title} as HTML`}
            className="bg-background/90 absolute top-2 right-2 opacity-0 shadow-sm group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100"
            data-testid="artifact-download"
            onClick={() => {
              void download(artifacts, artifact);
            }}
            size="icon-xs"
            title="Download HTML"
            variant="outline"
          >
            <Download />
          </Button>
        </div>
      </ActionContextMenu>
    </li>
  );
}
