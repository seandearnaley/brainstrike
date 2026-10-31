/**
 * The Settings › Updates switch (BST-2367): whether this install's update
 * checks offer beta releases. Main stores the choice in the desktop settings
 * store and applies it at the next check. PURE — bundled into the preload and
 * imported by main.
 */
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import { type Contract, channel, parseNoArgs } from '../platform/ipc-contract';
import { assertArgCount } from './contract-args';

export interface AppUpdatePreferences {
  /** Update checks offer the newest release, beta or stable, not only stable ones. */
  readonly betaUpdates: boolean;
}

export const appUpdatesContract = {
  getPreferences: channel<[], AppUpdatePreferences>({
    channel: DESKTOP_IPC_CHANNELS.appUpdates.getPreferences,
    parseArgs: parseNoArgs,
  }),
  setBetaUpdates: channel<[enabled: boolean], AppUpdatePreferences>({
    channel: DESKTOP_IPC_CHANNELS.appUpdates.setBetaUpdates,
    parseArgs: (raw) => {
      assertArgCount(raw, 1, 'app updates setBetaUpdates');
      const [enabled] = raw;
      if (typeof enabled !== 'boolean') {
        throw new TypeError('app updates setBetaUpdates requires a boolean');
      }
      return [enabled];
    },
  }),
} satisfies Contract;
