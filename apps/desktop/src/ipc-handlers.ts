import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import type { ContentClearResult } from '@brainstrike/types';
import type ElectronStore from 'electron-store';
import { registerStoragePreferencesIpcHandlers } from './ipc-domains/storage-preferences-ipc';
import {
  registerContentClearIpcHandlers,
  registerFactoryResetIpcHandlers,
  registerProfilePathIpcHandlers,
} from './ipc-factory-reset';
import type { DesktopSettingsStoreSchema } from './store-schema';

interface RegisterIpcHandlerOptions {
  readonly getUserDataPath?: () => string;
  readonly onClearContent?: () => Promise<ContentClearResult>;
  readonly onResetLocal?: () => Promise<{ success: boolean; message?: string }>;
  readonly onStorageChanged?: (key: string) => void;
}

/**
 * Register Main's application IPC handlers: the profile path, content clear, factory reset
 * and storage preferences. The workspace folders and their reads are the agent host's
 * (ADR-0029 stage 4); Main keeps only the folder dialog (`folder-picker-ipc.ts`).
 *
 * This file is intentionally a thin composition root. Domain ownership lives in
 * `ipc-domains/*` so adding a channel requires one domain contract, one handler,
 * and focused tests without growing a monolithic Electron main-process file.
 */
export function registerIpcHandlers(
  storage: ElectronStorageAdapter,
  getStore: () => ElectronStore<DesktopSettingsStoreSchema> | null,
  options: RegisterIpcHandlerOptions
): () => void {
  const retirements = [
    ...(options.getUserDataPath ? [registerProfilePathIpcHandlers(options.getUserDataPath)] : []),
    ...(options.onClearContent ? [registerContentClearIpcHandlers(options.onClearContent)] : []),
    ...(options.onResetLocal ? [registerFactoryResetIpcHandlers(options.onResetLocal)] : []),
    registerStoragePreferencesIpcHandlers({
      getStore,
      storage,
      ...(options.onStorageChanged ? { onStorageChanged: options.onStorageChanged } : {}),
    }),
  ];
  return () => {
    for (const retire of retirements) {
      retire();
    }
  };
}
