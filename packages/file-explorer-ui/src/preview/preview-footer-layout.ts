export const PREVIEW_FOOTER_MODES = ['compact', 'default', 'expanded'] as const;

export type PreviewFooterMode = (typeof PREVIEW_FOOTER_MODES)[number];

export const PREVIEW_FOOTER_HEIGHTS = {
  // Height when collapsed — just the header bar with resize handle and buttons.
  collapsed: 30,
  compact: 160,
  default: 228,
  expanded: 400,
  max: 540,
  // Slight undershoot while dragging keeps the resize handle usable before snapping to compact mode.
  min: 120,
  resizeStep: 8,
} as const;

export function clampPreviewFooterHeight(height: number): number {
  const roundedHeight = Math.round(height);
  return Math.max(PREVIEW_FOOTER_HEIGHTS.min, Math.min(roundedHeight, PREVIEW_FOOTER_HEIGHTS.max));
}

export function getPreviewFooterModeHeight(mode: PreviewFooterMode): number {
  switch (mode) {
    case 'compact': {
      return PREVIEW_FOOTER_HEIGHTS.compact;
    }
    case 'expanded': {
      return PREVIEW_FOOTER_HEIGHTS.expanded;
    }
    default: {
      return PREVIEW_FOOTER_HEIGHTS.default;
    }
  }
}

export function inferPreviewFooterMode(height: number): PreviewFooterMode {
  const clamped = clampPreviewFooterHeight(height);
  // Midpoints define deterministic snap zones. Exact threshold values bias toward the smaller mode.
  const compactThreshold = (PREVIEW_FOOTER_HEIGHTS.compact + PREVIEW_FOOTER_HEIGHTS.default) / 2;
  const expandedThreshold = (PREVIEW_FOOTER_HEIGHTS.default + PREVIEW_FOOTER_HEIGHTS.expanded) / 2;

  if (clamped <= compactThreshold) {
    return 'compact';
  }

  if (clamped >= expandedThreshold) {
    return 'expanded';
  }

  return 'default';
}
