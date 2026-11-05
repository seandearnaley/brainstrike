/** Pure contract for the visible renderer's profile data path. */
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import { type Bridge, type Contract, rawChannel } from '../platform/ipc-contract';

export const databasePathContract = {
  getUserDataPath: rawChannel<[], string>({
    channel: DESKTOP_IPC_CHANNELS.db.getUserDataPath,
  }),
} as const satisfies Contract;

export type DatabasePathBridge = Bridge<typeof databasePathContract>;
