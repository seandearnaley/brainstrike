/**
 * `clipboard` IPC contract (BST-1648). Writes go through main over IPC:
 * sandboxed preloads cannot require Electron's clipboard module. PURE —
 * bundled into the preload and imported by main.
 */
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import { parseSingleString } from '../platform/ipc-args';
import { type Contract, channel } from '../platform/ipc-contract';
import { assertArgCount } from './contract-args';

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export const clipboardContract = {
  /** PNG bytes, e.g. a diagram the user copies as an image. */
  writeImage: channel<[png: Uint8Array], void>({
    channel: DESKTOP_IPC_CHANNELS.clipboard.writeImage,
    parseArgs: (raw) => {
      assertArgCount(raw, 1, 'clipboard writeImage');
      const [png] = raw;
      if (!(png instanceof Uint8Array && PNG_SIGNATURE.every((byte, at) => png[at] === byte))) {
        throw new Error('clipboard writeImage requires PNG bytes');
      }
      return [png];
    },
  }),
  writeText: channel<[text: string], void>({
    channel: DESKTOP_IPC_CHANNELS.clipboard.writeText,
    parseArgs: parseSingleString('clipboard writeText requires a string payload'),
  }),
} satisfies Contract;
