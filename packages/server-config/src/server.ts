/**
 * Server configuration constants
 */
import { parsePositiveIntegerConfig } from '@brainstrike/platform-utils';

const PORT_KEY = 'PORT';
const DESKTOP_PORT_KEY = 'DESKTOP_PORT';
const MAX_PORT = 65_535;

// Use less common ports to avoid conflicts
const portEnv = globalThis.process?.env?.[PORT_KEY];
const desktopPortEnv = globalThis.process?.env?.[DESKTOP_PORT_KEY];

// Default ports - using 8080 range to avoid common conflicts
export const DEFAULT_WEB_PORT = parsePositiveIntegerConfig({
  defaultValue: 8080,
  maxValue: MAX_PORT,
  name: PORT_KEY,
  rawValue: portEnv,
});
export const DEFAULT_DESKTOP_PORT = parsePositiveIntegerConfig({
  defaultValue: 8081,
  maxValue: MAX_PORT,
  name: DESKTOP_PORT_KEY,
  rawValue: desktopPortEnv,
});

// Legacy port for backward compatibility (will be removed in future)
export const DEFAULT_PORT = DEFAULT_WEB_PORT;

// Port ranges for detection
export const WEB_PORT_RANGE = {
  end: DEFAULT_WEB_PORT + 5,
  start: DEFAULT_WEB_PORT,
};

export const DESKTOP_PORT_RANGE = {
  end: DEFAULT_DESKTOP_PORT + 5,
  start: DEFAULT_DESKTOP_PORT,
};

// Legacy port range for backward compatibility
export const PORT_RANGE = WEB_PORT_RANGE;

export const getBaseUrl = (port = DEFAULT_PORT) => `http://localhost:${port}`;

// Web and Desktop specific URL getters
export const getWebBaseUrl = (port = DEFAULT_WEB_PORT) => `http://localhost:${port}`;
export const getDesktopBaseUrl = (port = DEFAULT_DESKTOP_PORT) => `http://localhost:${port}`;

// Web and Desktop specific port checkers
export const getWebPortsToCheck = () =>
  Array.from(
    { length: WEB_PORT_RANGE.end - WEB_PORT_RANGE.start + 1 },
    (_, i) => WEB_PORT_RANGE.start + i
  );

export const getDesktopPortsToCheck = () =>
  Array.from(
    { length: DESKTOP_PORT_RANGE.end - DESKTOP_PORT_RANGE.start + 1 },
    (_, i) => DESKTOP_PORT_RANGE.start + i
  );
