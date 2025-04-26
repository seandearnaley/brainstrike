import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function isDevEnv(): boolean {
  // Vite uses import.meta.env.MODE, not process.env.NODE_ENV, by default in client code
  // See: https://vitejs.dev/guide/env-and-mode.html#env-variables
  // Type definition in vite-env.d.ts
  // In Node environments (like tests), import.meta.env might be undefined,
  // so we fall back to process.env.NODE_ENV which is commonly set there.
  return import.meta.env?.MODE === 'development' || process.env['NODE_ENV'] === 'development';
}
