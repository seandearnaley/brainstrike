import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import { type Contract, rawChannel } from '../platform/ipc-contract';

export const contentClearContract = {
  clear: rawChannel<['CONFIRM_CLEAR_DATABASE'], void>({
    channel: DESKTOP_IPC_CHANNELS.db.clearAll,
  }),
} as const satisfies Contract;
