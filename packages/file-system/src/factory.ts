import { ElectronFileSystemAdapter } from './adapters/electron-adapter';
import { MockFileSystemAdapter } from './adapters/mock-file-system-adapter';
import { WebFileSystemAdapter } from './adapters/web-adapter';
import type { FileSystemAdapter, Platform } from './types';

export function createFileSystemAdapter(platform: Platform): FileSystemAdapter {
  switch (platform) {
    case 'web':
      return new WebFileSystemAdapter();
    case 'electron':
      return new ElectronFileSystemAdapter();
    default:
      throw new Error(`Unknown platform: ${platform}`);
  }
}

export function createMockFileSystemAdapter(): FileSystemAdapter {
  return new MockFileSystemAdapter();
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
