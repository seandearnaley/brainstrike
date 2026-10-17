/** Every service in this fleet takes a port in its own block of the base range. */
const BASE_PORT = 8400;
const SERVICE_OFFSET = 17;

export const settings = {
  port: BASE_PORT + SERVICE_OFFSET,
  timeoutMs: 30_000,
};
