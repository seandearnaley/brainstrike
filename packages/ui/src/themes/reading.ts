/**
 * Reading choices for the chat transcript and the app's motion. The provider
 * writes each as a `data-*` attribute on <html>; the CSS that reads them lives
 * beside the surface it changes (assistant-ui/overrides.css for the
 * transcript, globals.css and the desktop `motion-reduce` variant for motion).
 */
export type TranscriptTextSize = 'small' | 'medium' | 'large';
export type TranscriptWidth = 'narrow' | 'wide' | 'full';
/** `reduced` turns motion down even when the device does not ask for it. */
export type MotionPreference = 'system' | 'reduced';

export interface ReadingOption<Id extends string> {
  readonly id: Id;
  readonly label: string;
}

export const DEFAULT_TRANSCRIPT_TEXT_SIZE: TranscriptTextSize = 'medium';
export const DEFAULT_TRANSCRIPT_WIDTH: TranscriptWidth = 'wide';
export const DEFAULT_MOTION: MotionPreference = 'system';

export const TRANSCRIPT_TEXT_SIZES: readonly ReadingOption<TranscriptTextSize>[] = [
  { id: 'small', label: 'Small' },
  { id: 'medium', label: 'Medium' },
  { id: 'large', label: 'Large' },
];

export const TRANSCRIPT_WIDTHS: readonly ReadingOption<TranscriptWidth>[] = [
  { id: 'narrow', label: 'Narrow' },
  { id: 'wide', label: 'Wide' },
  { id: 'full', label: 'Full' },
];

export const MOTION_PREFERENCES: readonly ReadingOption<MotionPreference>[] = [
  { id: 'system', label: 'System' },
  { id: 'reduced', label: 'Reduced' },
];

function isOneOf<Id extends string>(options: readonly ReadingOption<Id>[]) {
  const ids: ReadonlySet<string> = new Set(options.map((option) => option.id));
  return (value: unknown): value is Id => typeof value === 'string' && ids.has(value);
}

export const isTranscriptTextSize = isOneOf(TRANSCRIPT_TEXT_SIZES);
export const isTranscriptWidth = isOneOf(TRANSCRIPT_WIDTHS);
export const isMotionPreference = isOneOf(MOTION_PREFERENCES);
