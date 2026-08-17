export const PREVIEW_SUMMARY_MODES = ['compact', 'default', 'expanded'] as const;

export type PreviewSummaryMode = (typeof PREVIEW_SUMMARY_MODES)[number];
