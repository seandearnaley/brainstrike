import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import { type Contract, rawChannel } from '../platform/ipc-contract';

/** The existing profile reset operation, independent of SQL capabilities. */
export const factoryResetContract = {
  resetLocal: rawChannel<[], { readonly message?: string; readonly success: boolean }>({
    channel: DESKTOP_IPC_CHANNELS.db.resetLocal,
  }),
} as const satisfies Contract;
