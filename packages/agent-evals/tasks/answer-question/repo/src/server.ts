import { createServer } from 'node:http';
import { settings } from './settings.ts';

/** The port the server binds: PORT when it is set, else the configured default. */
export function listenPort(env: Readonly<Record<string, string | undefined>>): number {
  return Number(env['PORT'] ?? settings.port);
}

export function start(): void {
  createServer((_request, response) => response.end('ok')).listen(listenPort(process.env));
}
