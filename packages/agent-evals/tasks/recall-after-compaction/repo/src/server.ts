/** The port the service listens on. */
export const PORT = 3000;

export function address(host: string): string {
  return `${host}:${PORT}`;
}
