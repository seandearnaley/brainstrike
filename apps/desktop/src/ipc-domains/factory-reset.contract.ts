import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import { type Contract, rawChannel } from '../platform/ipc-contract';
import { assertArgCount } from './contract-args';

/** The existing profile reset operation, independent of SQL capabilities. */
export const factoryResetContract = {
  resetLocal: rawChannel<[], { readonly message?: string; readonly success: boolean }>({
    channel: DESKTOP_IPC_CHANNELS.db.resetLocal,
    parseArgs: (raw) => {
      assertArgCount(raw, 0, 'factory reset');
      return [];
    },
    roles: ['visible-ui'],
  }),
} as const satisfies Contract;
