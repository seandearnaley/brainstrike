import { Button, saveDownload } from '@brainstrike/ui';
import { Download } from 'lucide-react';
import type { ReactElement } from 'react';
import type {
  AssistantThreadHostArtifact,
  AssistantThreadHostArtifacts,
} from '../assistant-thread-host-context';
import { canvasHtmlFile } from '../canvas/download-canvas-html';
import { ArtifactThumbnail } from './artifact-thumbnail';

function download(
  artifacts: AssistantThreadHostArtifacts,
  artifact: AssistantThreadHostArtifact
): void {
  void saveDownload({
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

/**
 * One artifact in the gallery: its live preview, title, the thread it lives
 * in and when it last changed. The card opens it in its thread; the download
 * button saves its latest version as an HTML file.
 */
export function ArtifactCard({
  artifact,
  artifacts,
  onOpen,
  shellSrc,
  threadLabel,
  updatedLabel,
}: {
  readonly artifact: AssistantThreadHostArtifact;
  readonly artifacts: AssistantThreadHostArtifacts;
  readonly onOpen: (artifact: AssistantThreadHostArtifact) => void;
  readonly shellSrc: string;
  readonly threadLabel: string;
  readonly updatedLabel: string;
}): ReactElement {
  const title = artifact.title.trim() || 'Untitled canvas';
  return (
    <li className="group relative">
      <button
        className="border-border bg-card hover:border-primary/40 focus-visible:ring-ring flex w-full flex-col overflow-hidden rounded-lg border text-left transition-colors focus-visible:ring-2 focus-visible:outline-none motion-reduce:transition-none"
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
          <span className="text-foreground truncate text-sm font-medium">{title}</span>
          <span className="text-muted-foreground truncate text-xs">{threadLabel}</span>
          <span className="text-muted-foreground truncate text-xs tabular-nums">
            v{artifact.version} · {updatedLabel}
          </span>
        </span>
      </button>
      <Button
        aria-label={`Download ${title} as HTML`}
        className="bg-background/90 absolute top-2 right-2 opacity-0 shadow-sm group-hover:opacity-100 focus-visible:opacity-100"
        data-testid="artifact-download"
        onClick={() => {
          download(artifacts, artifact);
        }}
        size="icon-xs"
        title="Download HTML"
        variant="outline"
      >
        <Download />
      </Button>
    </li>
  );
}
