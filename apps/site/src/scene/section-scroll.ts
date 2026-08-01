export interface SectionScrollMetrics {
  readonly maximumScrollTop: number;
  readonly sectionDocumentTop: number;
}

function assertFiniteNonNegative(value: number, label: string): void {
  if (!(Number.isFinite(value) && value >= 0)) {
    throw new Error(`${label} must be a finite, non-negative number.`);
  }
}

export function computeSectionScrollTop({
  maximumScrollTop,
  sectionDocumentTop,
}: SectionScrollMetrics): number {
  assertFiniteNonNegative(sectionDocumentTop, 'Section document top');
  assertFiniteNonNegative(maximumScrollTop, 'Maximum scroll top');
  return Math.min(maximumScrollTop, sectionDocumentTop);
}
