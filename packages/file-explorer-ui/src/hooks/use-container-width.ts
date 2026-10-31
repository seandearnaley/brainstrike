/**
 * Observed content width of an element, in CSS pixels (BST-1208).
 *
 * The Explorer's responsive column step is a JS decision, not a CSS one: the
 * columns array is what `TreeTable` renders from, and a container query can
 * only hide a cell — it cannot stop `table-fixed` reserving that column's
 * width, which would leave the grid laid out for columns nobody can see.
 *
 * Sub-pixel churn is dropped so a fractional layout jitter cannot re-render the
 * tree, and `0` is reported until the element is measured so callers can tell
 * "not measured yet" from "genuinely tiny".
 */

import { useResizeObserver } from '@brainstrike/ui';
import { type RefObject, useState } from 'react';

export function useContainerWidth(elementRef: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);

  useResizeObserver(elementRef, (entry: ResizeObserverEntry) => {
    const nextWidth = entry.contentRect.width;
    setWidth((previous) => (Math.abs(previous - nextWidth) < 1 ? previous : nextWidth));
  });

  return width;
}
