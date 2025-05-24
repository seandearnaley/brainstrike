import { ElectronStorageAdapter } from './adapters/electron-storage-adapter';
import { MemoryStorageAdapter } from './adapters/memory-storage-adapter';
import { WebStorageAdapter } from './adapters/web-storage-adapter';
import type { Platform, StorageAdapter } from './types';

export function createStorageAdapter(platform: Platform): StorageAdapter {
  switch (platform) {
    case 'web':
      return new WebStorageAdapter();
    case 'electron':
      return new ElectronStorageAdapter();
    default:
      throw new Error(`Unknown platform: ${platform}`);
  }
}

export function createMemoryStorageAdapter(): StorageAdapter {
  return new MemoryStorageAdapter();
}

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
