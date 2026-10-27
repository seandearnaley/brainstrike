import { Button, toast } from '@brainstrike/ui';
import { getErrorMessage } from '@brainstrike/utils/error-utils';
import { Download } from 'lucide-react';
import type { ReactElement } from 'react';
import type {
  AssistantThreadHostArtifact,
  AssistantThreadHostArtifacts,
} from '../assistant-thread-host-context';
import { downloadCanvasHtml } from '../canvas/download-canvas-html';
import { ArtifactThumbnail } from './artifact-thumbnail';

async function download(
  artifacts: AssistantThreadHostArtifacts,
  artifact: AssistantThreadHostArtifact
): Promise<void> {
  try {
    const canvas = await artifacts.read(artifact.threadId, artifact.canvasId);
    if (!canvas) {
      throw new Error('This artifact is no longer in its thread.');
    }
    const { path } = await downloadCanvasHtml(canvas);
    toast({ description: path ?? 'Saved to your downloads.', title: 'Artifact saved' });
  } catch (error) {
    toast({
      description: getErrorMessage(error),
      title: 'Could not save the artifact',
      variant: 'destructive',
    });
  }
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
        className="flex w-full flex-col overflow-hidden rounded-lg border border-border bg-card text-left transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
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
        <span className="flex min-w-0 flex-col gap-0.5 border-border border-t px-3 py-2">
          <span className="truncate font-medium text-foreground text-sm">{title}</span>
          <span className="truncate text-muted-foreground text-xs">{threadLabel}</span>
          <span className="truncate text-muted-foreground text-xs tabular-nums">
            v{artifact.version} · {updatedLabel}
          </span>
        </span>
      </button>
      <Button
        aria-label={`Download ${title} as HTML`}
        className="absolute top-2 right-2 bg-background/90 opacity-0 shadow-sm focus-visible:opacity-100 group-hover:opacity-100"
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
    </li>
  );
}
