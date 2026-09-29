import { formatCanvasLink } from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import { PanelsTopLeft } from 'lucide-react';
import { type ReactElement, useCallback } from 'react';
import { useAssistantLinkCapabilities } from './assistant-link-capabilities';

const logger = createLogger('CanvasLinkChip');

/**
 * The `canvas://<canvasId>` chip under a settled manageCanvas card: the user
 * clicks straight into the document the assistant just wrote (approach plan
 * D2, 2026-09-15). It states only the INTENT through the assistant link seam;
 * the host (`packages/app-shell/use-assistant-link-capabilities.ts`) owns
 * where `canvas:` goes and the single visible failure, exactly as it does for
 * markdown links.
 *
 * An absent provider is a wiring bug. The markdown anchor logs and ignores
 * the click; a chip can do better — it renders DISABLED with the reason in
 * its title, which is louder than a log and can never be a silent dead click.
 */
export function CanvasLinkChip({
  canvasId,
  version,
}: {
  readonly canvasId: string;
  readonly version: number;
}): ReactElement {
  const capabilities = useAssistantLinkCapabilities();
  const href = formatCanvasLink(canvasId);

  const open = useCallback(() => {
    if (!capabilities) {
      return;
    }
    try {
      // `Promise.resolve` so a host that throws synchronously is caught by the
      // same handler as one that rejects (same shape as MarkdownLink).
      void Promise.resolve(capabilities.openLink(href)).catch((error: unknown) => {
        logger.error('Assistant link host rejected instead of resolving', { error, href });
      });
    } catch (error) {
      logger.error('Assistant link host threw instead of resolving', { error, href });
    }
  }, [capabilities, href]);

  return (
    <div className="px-2 pb-1.5">
      <button
        aria-label={`Open canvas ${canvasId}, version ${version}`}
        className="inline-flex max-w-full items-center gap-1 rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[11px] hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
        data-canvas-id={canvasId}
        data-testid="canvas-link-chip"
        disabled={!capabilities}
        onClick={open}
        title={capabilities ? href : 'Canvas links are not wired in this host'}
        type="button"
      >
        <PanelsTopLeft aria-hidden="true" className="size-3 shrink-0" />
        <span className="truncate font-mono">{href}</span>
        <span className="shrink-0 text-muted-foreground tabular-nums">v{version}</span>
      </button>
    </div>
  );
}
