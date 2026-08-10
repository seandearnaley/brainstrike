/**
 * Collection debug drawer (BST-1214).
 *
 * The only windows into embeddings the app still has after the Collection
 * Browser was retired: a chunk/embedding inspector, a scored retrieval
 * preview, and a failed/pending embedding list — all scoped to the active
 * collection.
 *
 * Deliberately cheap: collapsed by default, content code-split behind
 * `React.lazy`, and every data hook lives inside that lazy content so a closed
 * drawer costs one button. Self-contained in this folder so it can be deleted
 * in one PR if it goes unused.
 */

import { ChevronRight, Wrench } from 'lucide-react';
import { lazy, Suspense, useCallback, useId } from 'react';
import { useDatabaseDemoStore } from '../../stores/database-demo-store';
import type { CollectionDebugDrawerProps } from './drawer-props';

const CollectionDebugDrawerContent = lazy(() => import('./collection-debug-drawer-content'));

export function CollectionDebugDrawer(props: CollectionDebugDrawerProps) {
  const open = useDatabaseDemoStore((s) => s.debugDrawerOpen);
  const setOpen = useDatabaseDemoStore((s) => s.setDebugDrawerOpen);
  const contentId = useId();

  const handleToggle = useCallback(() => setOpen(!open), [open, setOpen]);

  return (
    <section
      className="flex min-h-0 shrink-0 flex-col border-t bg-background"
      data-testid="collection-debug-drawer"
    >
      <h2 className="contents">
        <button
          aria-controls={contentId}
          aria-expanded={open}
          className="flex h-9 w-full shrink-0 items-center gap-2 px-4 text-left text-muted-foreground text-xs transition-colors hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
          data-testid="collection-debug-drawer-toggle"
          onClick={handleToggle}
          type="button"
        >
          <ChevronRight
            aria-hidden="true"
            className={`size-3.5 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
          />
          <Wrench aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="font-medium">Collection details</span>
        </button>
      </h2>

      {/* The container is always present so `aria-controls` always resolves;
          only its contents are mounted on demand. */}
      <div className="flex min-h-0 flex-col" id={contentId}>
        {open ? (
          <Suspense
            fallback={
              <div className="px-4 py-3 text-muted-foreground text-xs" role="status">
                Loading collection details…
              </div>
            }
          >
            <CollectionDebugDrawerContent {...props} />
          </Suspense>
        ) : null}
      </div>
    </section>
  );
}
