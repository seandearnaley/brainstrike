/**
 * Settings › Updates. The switch (BST-2367) picks whether this install's
 * update checks offer beta releases; Main stores the choice in the desktop
 * settings store and applies it at the next check. The status (BST-2356) is
 * Main's update check: `checkNow` runs one, `restartToUpdate` installs a
 * downloaded update, and `onStatusChange` pushes every change to the
 * renderer. PURE — bundled into the preload and imported by main.
 */
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import { type Contract, channel, parseNoArgs, pushEvent } from '../platform/ipc-contract';
import { assertArgCount } from './contract-args';

export interface AppUpdatePreferences {
  /** Update checks offer the newest release, beta or stable, not only stable ones. */
  readonly betaUpdates: boolean;
}

/**
 * Where this install's updates stand. `off` never checks: an unpackaged or
 * test build is `not-installed`, and after a factory reset checks resume at
 * the next launch. A finished download is `ready` until the app quits.
 */
export type AppUpdateStatus =
  | { readonly reason: 'not-installed' | 'reset'; readonly state: 'off' }
  | { readonly state: 'idle' }
  | { readonly state: 'checking' }
  | { readonly state: 'up-to-date' }
  | { readonly state: 'downloading'; readonly version: string }
  | { readonly state: 'ready'; readonly version: string }
  | { readonly message: string; readonly state: 'failed' };

export const appUpdatesContract = {
  checkNow: channel<[], AppUpdateStatus>({
    channel: DESKTOP_IPC_CHANNELS.appUpdates.checkNow,
    parseArgs: parseNoArgs,
  }),
  getPreferences: channel<[], AppUpdatePreferences>({
    channel: DESKTOP_IPC_CHANNELS.appUpdates.getPreferences,
    parseArgs: parseNoArgs,
  }),
  getStatus: channel<[], AppUpdateStatus>({
    channel: DESKTOP_IPC_CHANNELS.appUpdates.getStatus,
    parseArgs: parseNoArgs,
  }),
  onStatusChange: pushEvent<AppUpdateStatus>({
    channel: DESKTOP_IPC_CHANNELS.appUpdates.statusChanged,
  }),
  restartToUpdate: channel<[], void>({
    channel: DESKTOP_IPC_CHANNELS.appUpdates.restartToUpdate,
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
