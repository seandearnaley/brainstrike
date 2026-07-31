export interface SectionScrollMetrics {
  readonly contentDocumentTop: number;
  readonly contentHeight: number;
  readonly headerHeight: number;
  readonly maximumScrollTop: number;
  readonly viewportGap: number;
  readonly viewportHeight: number;
}

function assertFiniteNonNegative(value: number, label: string): void {
  if (!(Number.isFinite(value) && value >= 0)) {
    throw new Error(`${label} must be a finite, non-negative number.`);
  }
}

export function computeSectionScrollTop({
  contentDocumentTop,
  contentHeight,
  headerHeight,
  maximumScrollTop,
  viewportGap,
  viewportHeight,
}: SectionScrollMetrics): number {
  assertFiniteNonNegative(contentDocumentTop, 'Content document top');
  assertFiniteNonNegative(contentHeight, 'Content height');
  assertFiniteNonNegative(headerHeight, 'Header height');
  assertFiniteNonNegative(maximumScrollTop, 'Maximum scroll top');
  assertFiniteNonNegative(viewportGap, 'Viewport gap');
  assertFiniteNonNegative(viewportHeight, 'Viewport height');

  const usableHeight = viewportHeight - headerHeight - viewportGap * 2;
  if (usableHeight <= 0) {
    throw new Error('Section navigation requires positive usable viewport height.');
  }

  const centeredOffset = Math.max(0, (usableHeight - contentHeight) / 2);
  const desiredViewportTop = headerHeight + viewportGap + centeredOffset;
  const requestedScrollTop = contentDocumentTop - desiredViewportTop;
  return Math.min(maximumScrollTop, Math.max(0, requestedScrollTop));
}
