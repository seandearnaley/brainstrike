export type Platform = 'web' | 'electron';

export function detectPlatform(): Platform {
  try {
    // Check if we're in Electron renderer process
    if (typeof window !== 'undefined') {
      const windowWithProcess = window as typeof window & { process?: { type?: string } };
      if (windowWithProcess.process?.type === 'renderer') {
        return 'electron';
      }
    }

    // Check if we're in Node.js/Electron main process
    if (typeof globalThis !== 'undefined') {
      const globalWithProcess = globalThis as typeof globalThis & {
        process?: { versions?: { electron?: string } };
      };
      if (globalWithProcess.process?.versions?.electron) {
        return 'electron';
      }
    }
  } catch {
    // Ignore errors during detection
  }

  // Default to web
  return 'web';
}

export interface PositiveIntegerConfigInput {
  defaultValue?: number;
  name: string;
  rawValue: number | string | null | undefined;
}

function assertPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer, received ${value}.`);
  }
  return value;
}

export function parsePositiveIntegerConfig({
  defaultValue,
  name,
  rawValue,
}: PositiveIntegerConfigInput): number {
  if (typeof rawValue === 'number') {
    return assertPositiveInteger(rawValue, name);
  }
  if (rawValue === undefined || rawValue === null || rawValue.trim() === '') {
    if (defaultValue === undefined) {
      throw new Error(`${name} must be a positive integer.`);
    }
    return assertPositiveInteger(defaultValue, `${name} default`);
  }

  const trimmedValue = rawValue.trim();
  if (!/^\d+$/.test(trimmedValue)) {
    throw new Error(`${name} must be a positive integer, received "${rawValue}".`);
  }
  const parsed = Number(trimmedValue);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, received "${rawValue}".`);
  }
  return parsed;
}
