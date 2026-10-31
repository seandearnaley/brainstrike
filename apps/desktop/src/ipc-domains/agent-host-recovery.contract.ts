/**
 * The damaged-store notice's desktop actions (BST-1880). `restartHost` stops the
 * agent host this app launched, so it relaunches for the next client and its
 * state store reopens and checks itself again; `showDataFolder` opens the
 * profile's data folder. PURE — bundled into the preload and imported by main.
 */
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import { type Contract, channel } from '../platform/ipc-contract';

export const agentHostRecoveryContract = {
  restartHost: channel<[], void>({
    channel: DESKTOP_IPC_CHANNELS.agent.hostRestart,
  }),
  showDataFolder: channel<[], void>({
    channel: DESKTOP_IPC_CHANNELS.agent.showDataFolder,
  }),
} satisfies Contract;
