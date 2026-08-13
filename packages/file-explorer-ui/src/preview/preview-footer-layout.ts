export const PREVIEW_FOOTER_MODES = ['compact', 'default', 'expanded'] as const;

export type PreviewFooterMode = (typeof PREVIEW_FOOTER_MODES)[number];
