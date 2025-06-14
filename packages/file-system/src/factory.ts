import type { FolderService } from '@brainstrike/file-cache';
import { type Platform, detectPlatform } from '@brainstrike/platform-utils';
import { ElectronFileSystemAdapter } from './adapters/electron-adapter';
import { MockFileSystemAdapter } from './adapters/mock-file-system-adapter';
import { WebFileSystemAdapter } from './adapters/web-adapter';
import type { DatabaseAwareFileSystemAdapter } from './database-adapter';
import type { FileSystemAdapter } from './types';

export interface CreateAdapterOptions {
  folderService?: FolderService;
  databaseMode?: boolean;
}

export function createFileSystemAdapter(
  platform: Platform,
  options?: CreateAdapterOptions
): FileSystemAdapter {
  let adapter: DatabaseAwareFileSystemAdapter;

  switch (platform) {
    case 'web':
      adapter = new WebFileSystemAdapter();
      break;
    case 'electron':
      adapter = new ElectronFileSystemAdapter();
      break;
    default:
      throw new Error(`Unknown platform: ${platform}`);
  }

  // Configure database awareness if options provided
  if (options?.folderService) {
    adapter.setFolderService(options.folderService);
  }
  if (options?.databaseMode !== undefined) {
    adapter.setDatabaseMode(options.databaseMode);
  }

  return adapter;
}

export function createMockFileSystemAdapter(): FileSystemAdapter {
  return new MockFileSystemAdapter();
}

export { detectPlatform };
