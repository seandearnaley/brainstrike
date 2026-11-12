import type { ResetOutcome, WorktreeResetOutcome } from '@brainstrike/types';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import { type Contract, rawChannel } from '../platform/ipc-contract';

/** The existing profile reset operation, independent of SQL capabilities. */
export const factoryResetContract = {
  resetLocal: rawChannel<
    [],
    {
      readonly managedWorktrees?: WorktreeResetOutcome;
      readonly message?: string;
      readonly success: boolean;
    }
  >({
    channel: DESKTOP_IPC_CHANNELS.db.resetLocal,
  }),
  /**
   * ADR-0034: what the last reset (Factory Reset or Clear Database) did with the managed
   * worktrees and scratch folders, once. The window that asked for the reset is replaced before
   * the reset answers, so its replacement takes this as it starts.
   */
  takeResetOutcome: rawChannel<[], ResetOutcome | null>({
    channel: DESKTOP_IPC_CHANNELS.db.takeResetOutcome,
  }),
} as const satisfies Contract;
