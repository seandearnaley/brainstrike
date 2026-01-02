import type { BrowserWindow, Rectangle } from 'electron';
import type ElectronStore from 'electron-store';
import type {
  DesktopSettingsStoreSchema,
  DesktopWindowBounds,
  DesktopWindowState,
} from './store-schema';

const WINDOW_STATE_KEY = 'windowState';
const WINDOW_STATE_DEBOUNCE_MS = 200;

const DEFAULT_WINDOW_BOUNDS: DesktopWindowBounds = {
  width: 1536,
  height: 800,
};

const MIN_WINDOW_BOUNDS = {
  width: 800,
  height: 600,
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const toRoundedNumber = (value: unknown): number | undefined =>
  isFiniteNumber(value) ? Math.round(value) : undefined;

const normalizeBounds = (
  raw: Partial<DesktopWindowBounds> | Rectangle | null | undefined
): DesktopWindowBounds => {
  const width = Math.max(
    MIN_WINDOW_BOUNDS.width,
    toRoundedNumber(raw?.width) ?? DEFAULT_WINDOW_BOUNDS.width
  );
  const height = Math.max(
    MIN_WINDOW_BOUNDS.height,
    toRoundedNumber(raw?.height) ?? DEFAULT_WINDOW_BOUNDS.height
  );
  const x = toRoundedNumber(raw?.x);
  const y = toRoundedNumber(raw?.y);
  const normalized: DesktopWindowBounds = { width, height };

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

export const resolveInitialWindowState = (
  stored: DesktopWindowState | null | undefined
): DesktopWindowState => stored ?? getDefaultWindowState();

export const readStoredWindowState = (
  store: ElectronStore<DesktopSettingsStoreSchema>
): DesktopWindowState | null => {
  try {
    const record = (
      store as ElectronStore<DesktopSettingsStoreSchema> & { get: (key: string) => unknown }
    ).get(WINDOW_STATE_KEY) as DesktopSettingsStoreSchema['windowState'] | undefined;
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
    (
      store as ElectronStore<DesktopSettingsStoreSchema> & {
        set: (key: string, value: unknown) => void;
      }
    ).set(WINDOW_STATE_KEY, { v1: state });
  } catch {
    // Persistence failures should not crash the app.
  }
};

export const registerWindowStatePersistence = (
  win: BrowserWindow,
  store: ElectronStore<DesktopSettingsStoreSchema>
): void => {
  let debounce: ReturnType<typeof setTimeout> | null = null;

  const persistNow = () => {
    if (debounce) {
      clearTimeout(debounce);
      debounce = null;
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
};
