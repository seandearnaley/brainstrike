/**
 * `clipboard` IPC contract (BST-1648). Writes go through main over IPC:
 * sandboxed preloads cannot require Electron's clipboard module. PURE —
 * bundled into the preload and imported by main.
 */
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import { type Contract, channel } from '../platform/ipc-contract';

export const clipboardContract = {
  /** PNG bytes, e.g. a diagram the user copies as an image. */
  writeImage: channel<[png: Uint8Array], void>({
    channel: DESKTOP_IPC_CHANNELS.clipboard.writeImage,
  }),
  writeText: channel<[text: string], void>({
    channel: DESKTOP_IPC_CHANNELS.clipboard.writeText,
  }),
} satisfies Contract;
