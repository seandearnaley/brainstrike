import { CanvasFrame, useResolvedTheme } from '@brainstrike/ui';
import { getErrorMessage } from '@brainstrike/utils/error-utils';
import { PanelsTopLeft } from 'lucide-react';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import type { AssistantThreadHostArtifacts } from '../assistant-thread-host-context';

/** The page width a thumbnail lays the canvas out at before scaling it down. */
const VIRTUAL_WIDTH = 1024;
const VIRTUAL_HEIGHT = 768;

type Preview =
  | { readonly status: 'idle' }
  | { readonly error: string; readonly status: 'error' }
  | { readonly html: string; readonly status: 'ready' }
  | { readonly status: 'missing' };

/**
 * True while the element is on screen (with a margin). Each thumbnail is a
 * live sandboxed frame, so only cards near the viewport run one. Without
 * IntersectionObserver every card counts as visible.
 */
function useNearViewport(element: HTMLElement | null): boolean {
  const [near, setNear] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (!element || typeof IntersectionObserver === 'undefined') {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => setNear(entries.some((entry) => entry.isIntersecting)),
      { rootMargin: '200px' }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return near;
}

/**
 * The element's width, so the frame scales to fill it. An observer reports an
 * element's size as soon as it starts observing; without one the width stays
 * 0 and the card keeps its placeholder.
 */
function useWidth(element: HTMLElement | null): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!element || typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return width;
}

/**
 * A live, scaled-down preview of an artifact's latest version: the canvas runs
 * in the same sandboxed CanvasFrame as its tab, laid out at a desktop width,
 * and is inert, so the card stays the only thing a click or Tab reaches. The
 * document is read once the card nears the viewport.
 */
export function ArtifactThumbnail({
  artifacts,
  canvasId,
  shellSrc,
  threadId,
  version,
}: {
  readonly artifacts: AssistantThreadHostArtifacts;
  readonly canvasId: string;
  readonly shellSrc: string;
  readonly threadId: string;
  /** The listed version: a newer one reads the document again. */
  readonly version: number;
}): ReactElement {
  const theme = useResolvedTheme();
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const near = useNearViewport(container);
  const width = useWidth(container);
  const [preview, setPreview] = useState<Preview>({ status: 'idle' });
  const requested = useRef<string | null>(null);

  useEffect(() => {
    const key = `${threadId}\n${canvasId}\n${version}`;
    if (!near || requested.current === key) {
      return;
    }
    requested.current = key;
    let cancelled = false;
    artifacts.read(threadId, canvasId).then(
      (canvas) => {
        if (!cancelled) {
          setPreview(canvas ? { html: canvas.html, status: 'ready' } : { status: 'missing' });
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          requested.current = null;
          setPreview({ error: getErrorMessage(error), status: 'error' });
        }
      }
    );
    return () => {
      cancelled = true;
    };
  }, [artifacts, canvasId, near, threadId, version]);

  const scale = width > 0 ? width / VIRTUAL_WIDTH : 0;
  return (
    <div
      aria-hidden="true"
      className="relative aspect-[4/3] w-full overflow-hidden bg-muted/40"
      ref={setContainer}
    >
      {preview.status === 'ready' && near && scale > 0 ? (
        <div
          className="pointer-events-none absolute top-0 left-0 origin-top-left bg-background"
          inert
          style={{
            height: VIRTUAL_HEIGHT,
            transform: `scale(${scale})`,
            width: VIRTUAL_WIDTH,
          }}
        >
          <CanvasFrame html={preview.html} shellSrc={shellSrc} theme={theme} />
        </div>
      ) : (
        <div className="flex h-full items-center justify-center">
          <PanelsTopLeft className="size-8 text-muted-foreground/60" />
        </div>
      )}
      {preview.status === 'error' ? (
        <p className="absolute inset-x-0 bottom-0 truncate bg-background/90 px-2 py-1 text-destructive text-xs">
          Preview failed: {preview.error}
        </p>
      ) : null}
    </div>
  );
}
