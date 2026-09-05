/**
 * `clipboard` IPC contract (BST-1648). Writes go through main over IPC:
 * sandboxed preloads cannot require Electron's clipboard module. PURE —
 * bundled into the preload and imported by main.
 */
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import { parseSingleString } from '../platform/ipc-args';
import { type Bridge, type Contract, channel } from '../platform/ipc-contract';

export const clipboardContract = {
  writeText: channel<[text: string], void>({
    channel: DESKTOP_IPC_CHANNELS.clipboard.writeText,
    parseArgs: parseSingleString('clipboard writeText requires a string payload'),
    roles: ['visible-ui'],
  }),
} satisfies Contract;

export type ClipboardBridge = Bridge<typeof clipboardContract>;
