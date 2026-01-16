export const MIN_PANEL_SIZE_THRESHOLD = 10;

export const DEFAULT_LEFT_PANEL_SIZE = 25;
export const DEFAULT_RIGHT_PANEL_SIZE = 20;
export const DEFAULT_CONSOLE_SIZE = 20;

export const DEFAULT_PANEL_SIZES = [
  DEFAULT_LEFT_PANEL_SIZE,
  DEFAULT_RIGHT_PANEL_SIZE,
  DEFAULT_CONSOLE_SIZE,
] as const;

// Minimum sizes to enforce when panels are visible (match ide-layout minSize props).
export const MIN_PANEL_SIZES = [15, 15, 15] as const;
