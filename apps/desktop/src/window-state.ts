import { type BrowserWindow, type Rectangle, screen } from 'electron';
import type ElectronStore from 'electron-store';
import type {
  DesktopSettingsStoreSchema,
  DesktopWindowBounds,
  DesktopWindowState,
} from './store-schema';

const WINDOW_STATE_KEY = 'windowState' satisfies keyof DesktopSettingsStoreSchema;
const WINDOW_STATE_DEBOUNCE_MS = 200; // Debounce state persistence to reduce disk writes during window interactions.

const DEFAULT_WINDOW_BOUNDS: DesktopWindowBounds = {
  width: 1536,
  height: 800,
};

const MIN_WINDOW_BOUNDS = {
  width: 800,
  height: 600,
};

type WindowStateStore = ElectronStore<DesktopSettingsStoreSchema> & {
  get: (key: typeof WINDOW_STATE_KEY) => DesktopSettingsStoreSchema[typeof WINDOW_STATE_KEY];
  set: (
    key: typeof WINDOW_STATE_KEY,
    value: DesktopSettingsStoreSchema[typeof WINDOW_STATE_KEY]
  ) => void;
};

const asWindowStateStore = (store: ElectronStore<DesktopSettingsStoreSchema>): WindowStateStore =>
  store as WindowStateStore;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const toRoundedNumber = (value: unknown): number | undefined =>
  isFiniteNumber(value) ? Math.round(value) : undefined;

const normalizeBounds = (
  raw: Partial<DesktopWindowBounds> | Rectangle | null | undefined
): DesktopWindowBounds => {
  const normalizedWidth = Math.max(
    MIN_WINDOW_BOUNDS.width,
    toRoundedNumber(raw?.width) ?? DEFAULT_WINDOW_BOUNDS.width
  );
  const normalizedHeight = Math.max(
    MIN_WINDOW_BOUNDS.height,
    toRoundedNumber(raw?.height) ?? DEFAULT_WINDOW_BOUNDS.height
  );
  const x = toRoundedNumber(raw?.x);
  const y = toRoundedNumber(raw?.y);
  const normalized: DesktopWindowBounds = { width: normalizedWidth, height: normalizedHeight };

  if (x !== undefined) {
    normalized.x = x;
  }

  if (y !== undefined) {
    normalized.y = y;
  }

  return normalized;
};

const normalizeWindowState = (raw: unknown): DesktopWindowState | null => {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const candidate = raw as Partial<DesktopWindowState>;
  const bounds = normalizeBounds(candidate.bounds);
  const isFullScreen = typeof candidate.isFullScreen === 'boolean' ? candidate.isFullScreen : false;
  const isMaximized = typeof candidate.isMaximized === 'boolean' ? candidate.isMaximized : false;

  return {
    bounds,
    isFullScreen,
    isMaximized: isFullScreen ? false : isMaximized,
  };
};

export const getDefaultWindowState = (): DesktopWindowState => ({
  bounds: { ...DEFAULT_WINDOW_BOUNDS },
  isFullScreen: false,
  isMaximized: true,
});

const rectanglesIntersect = (first: Rectangle, second: Rectangle): boolean => {
  const left = Math.max(first.x, second.x);
  const right = Math.min(first.x + first.width, second.x + second.width);
  const top = Math.max(first.y, second.y);
  const bottom = Math.min(first.y + first.height, second.y + second.height);

  return right > left && bottom > top;
};

const clampSizeToWorkArea = (
  bounds: DesktopWindowBounds,
  workArea: Rectangle
): DesktopWindowBounds => ({
  ...bounds,
  width: Math.min(bounds.width, workArea.width),
  height: Math.min(bounds.height, workArea.height),
});

const clampBoundsToWorkArea = (
  bounds: DesktopWindowBounds,
  workArea: Rectangle
): DesktopWindowBounds => {
  const width = Math.min(bounds.width, workArea.width);
  const height = Math.min(bounds.height, workArea.height);
  const x = bounds.x ?? workArea.x;
  const y = bounds.y ?? workArea.y;

  return {
    width,
    height,
    x: Math.min(Math.max(x, workArea.x), workArea.x + workArea.width - width),
    y: Math.min(Math.max(y, workArea.y), workArea.y + workArea.height - height),
  };
};

export const ensureWindowBoundsVisible = (state: DesktopWindowState): DesktopWindowState => {
  const { bounds } = state;
  const displays = screen.getAllDisplays();

  if (displays.length === 0) {
    return state;
  }

  const primaryDisplay = displays[0];
  if (!primaryDisplay) {
    return state;
  }

  if (bounds.x === undefined || bounds.y === undefined) {
    return {
      ...state,
      bounds: clampSizeToWorkArea(bounds, primaryDisplay.workArea),
    };
  }

  const windowRect: Rectangle = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  };
  const matchingDisplay = displays.find((display) =>
    rectanglesIntersect(windowRect, display.workArea)
  );

  if (!matchingDisplay) {
    return {
      ...state,
      bounds: clampSizeToWorkArea(getDefaultWindowState().bounds, primaryDisplay.workArea),
    };
  }

  return {
    ...state,
    bounds: clampBoundsToWorkArea(bounds, matchingDisplay.workArea),
  };
};

export const resolveInitialWindowState = (
  stored: DesktopWindowState | null | undefined
): DesktopWindowState => stored ?? getDefaultWindowState();

export const readStoredWindowState = (
  store: ElectronStore<DesktopSettingsStoreSchema>
): DesktopWindowState | null => {
  try {
    const record = asWindowStateStore(store).get(WINDOW_STATE_KEY);
    return normalizeWindowState(record?.v1);
  } catch {
    return null;
  }
};

export const captureWindowState = (win: BrowserWindow): DesktopWindowState => {
  const isFullScreen = win.isFullScreen();
  const isMaximized = win.isMaximized();
  const rawBounds = isFullScreen || isMaximized ? win.getNormalBounds() : win.getBounds();

  return {
    bounds: normalizeBounds(rawBounds),
    isFullScreen,
    isMaximized: isFullScreen ? false : isMaximized,
  };
};

export const persistWindowState = (
  store: ElectronStore<DesktopSettingsStoreSchema>,
  state: DesktopWindowState
): void => {
  try {
    asWindowStateStore(store).set(WINDOW_STATE_KEY, { v1: state });
  } catch {
    // Persistence failures should not crash the app.
  }
};

/**
 * Wire window-bounds persistence to a BrowserWindow.
 *
 * Returns a disposer that removes every listener and clears the pending debounce
 * timer. The caller MUST invoke it when the window is destroyed (e.g. on
 * `'closed'`): `app.on('activate')` recreates the main window, so without
 * cleanup the listeners + timer accumulate per window, and a debounce firing
 * after destruction would call `captureWindowState` on a dead window and throw.
 */
export const registerWindowStatePersistence = (
  win: BrowserWindow,
  store: ElectronStore<DesktopSettingsStoreSchema>
): (() => void) => {
  let debounce: ReturnType<typeof setTimeout> | null = null;

  const clearDebounce = () => {
    if (debounce) {
      clearTimeout(debounce);
      debounce = null;
    }
  };

  const persistNow = () => {
    clearDebounce();
    // A debounce can fire after the window is destroyed (race with teardown).
    // captureWindowState() calls win.isFullScreen() — which throws on a dead
    // window — outside persistWindowState's try/catch, so guard here.
    if (win.isDestroyed()) {
      return;
    }
    persistWindowState(store, captureWindowState(win));
  };

  const schedulePersist = () => {
    if (debounce) {
      clearTimeout(debounce);
    }
    debounce = setTimeout(persistNow, WINDOW_STATE_DEBOUNCE_MS);
  };

  win.on('resize', schedulePersist);
  win.on('move', schedulePersist);
  win.on('maximize', schedulePersist);
  win.on('unmaximize', schedulePersist);
  win.on('enter-full-screen', schedulePersist);
  win.on('leave-full-screen', schedulePersist);
  win.on('close', persistNow);

  return () => {
    clearDebounce();
    win.removeListener('resize', schedulePersist);
    win.removeListener('move', schedulePersist);
    win.removeListener('maximize', schedulePersist);
    win.removeListener('unmaximize', schedulePersist);
    win.removeListener('enter-full-screen', schedulePersist);
    win.removeListener('leave-full-screen', schedulePersist);
    win.removeListener('close', persistNow);
  };
};
