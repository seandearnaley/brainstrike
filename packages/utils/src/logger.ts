import { isDevEnv } from './env-utils';

/**
 * Simple logger utility that only logs in development environment.
 */
export function debug(...args: unknown[]): void {
  if (isDevEnv()) {
    // eslint-disable-next-line no-console
    console.log(...args);
  }
}

export function warn(...args: unknown[]): void {
  if (isDevEnv()) {
    // eslint-disable-next-line no-console
    console.warn(...args);
  }
}

export function error(...args: unknown[]): void {
  if (isDevEnv()) {
    // eslint-disable-next-line no-console
    console.error(...args);
  }
}
