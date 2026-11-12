import type { ResetOutcome } from '@brainstrike/types';
import { Schema } from 'effect';
import { ipcMain } from 'electron';
import type { DesktopFactoryResetResult } from './desktop-reset-platform';
import { getFactoryResetUnavailableReason } from './factory-reset-availability';
import { contentClearContract } from './ipc-domains/content-clear.contract';
import { databasePathContract } from './ipc-domains/database.contract';
import { factoryResetContract } from './ipc-domains/factory-reset.contract';
import { createDesktopIpcRegistry, registerDomain } from './platform/desktop-ipc-registry';
import { NoArgs } from './platform/ipc-args';

/** Main's Factory Reset owner, as the renderer reaches it. */
export interface FactoryResetIpcOwner {
  reset(): Promise<DesktopFactoryResetResult>;
  /** ADR-0034: the last reset's worktrees and scratch folders, once, for the replacement window. */
  takeResetOutcome(): ResetOutcome | null;
}

export function registerFactoryResetIpcHandlers(owner: FactoryResetIpcOwner): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  registerDomain(
    registry,
    'runtime',
    factoryResetContract,
    { resetLocal: NoArgs, takeResetOutcome: NoArgs },
    {
      resetLocal: () => {
        const unavailableReason = getFactoryResetUnavailableReason(process.platform);
        return unavailableReason ? { message: unavailableReason, success: false } : owner.reset();
      },
      takeResetOutcome: () => owner.takeResetOutcome(),
    }
  );
  return () => registry.unregisterAll();
}

export function registerProfilePathIpcHandlers(getUserDataPath: () => string): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  registerDomain(
    registry,
    'runtime',
    databasePathContract,
    { getUserDataPath: NoArgs },
    { getUserDataPath }
  );
  return () => registry.unregisterAll();
}

export function registerContentClearIpcHandlers(clear: () => Promise<void>): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  registerDomain(
    registry,
    'runtime',
    contentClearContract,
    { clear: Schema.Tuple([Schema.Literal('CONFIRM_CLEAR_DATABASE')]) },
    { clear }
  );
  return () => registry.unregisterAll();
}
