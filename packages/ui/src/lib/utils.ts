import { createDebounce } from '@brainstrike/utils';
import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Export debounce utility
export { createDebounce };
