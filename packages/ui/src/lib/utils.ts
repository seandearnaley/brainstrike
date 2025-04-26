import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function isDevEnv(): boolean {
  return (process.env as Record<string, string | undefined>)['NODE_ENV'] === 'development';
}
