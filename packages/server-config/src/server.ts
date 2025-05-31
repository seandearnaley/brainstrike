/**
 * Server configuration constants
 */
const PORT_KEY = 'PORT';
const portEnv = globalThis.process?.env?.[PORT_KEY];
export const DEFAULT_PORT = portEnv ? Number.parseInt(portEnv, 10) : 3000;
export const PORT_RANGE = {
  start: DEFAULT_PORT,
  end: DEFAULT_PORT + 5,
};

export const getBaseUrl = (port = DEFAULT_PORT) => `http://localhost:${port}`;

// Generate array of ports to check
export const getPortsToCheck = () =>
  Array.from({ length: PORT_RANGE.end - PORT_RANGE.start + 1 }, (_, i) => PORT_RANGE.start + i);
