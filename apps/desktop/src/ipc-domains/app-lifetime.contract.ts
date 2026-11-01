/**
 * Settings › Startup (ADR-0033): whether closing the last window leaves
 * Brainstrike running in the tray, and whether it opens at login. Main owns
 * both: the tray choice in the desktop settings store, the login item in the
 * OS. PURE — bundled into the preload and imported by main.
 */
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import { type Contract, channel } from '../platform/ipc-contract';

/** A switch this install offers, or why it does not. */
export type AppLifetimeSwitch =
  | { readonly available: true; readonly enabled: boolean }
  | { readonly available: false; readonly reason: string };

export interface AppLifetimeSettings {
  /** Null where the Dock keeps the app running (macOS): there is no tray to choose. */
  readonly keepRunningInTray: AppLifetimeSwitch | null;
  /** What closing the last window does now. */
  readonly lastWindowClose: 'keeps-running' | 'quits';
  readonly openAtLogin: AppLifetimeSwitch;
}

export const appLifetimeContract = {
  getSettings: channel<[], AppLifetimeSettings>({
    channel: DESKTOP_IPC_CHANNELS.appLifetime.getSettings,
  }),
  setKeepRunningInTray: channel<[enabled: boolean], AppLifetimeSettings>({
    channel: DESKTOP_IPC_CHANNELS.appLifetime.setKeepRunningInTray,
  }),
  setOpenAtLogin: channel<[enabled: boolean], AppLifetimeSettings>({
    channel: DESKTOP_IPC_CHANNELS.appLifetime.setOpenAtLogin,
  }),
} satisfies Contract;
