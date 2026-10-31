import { Schema } from 'effect';
import type { clipboardContract } from './ipc-domains/clipboard.contract';
import { settleIpcResult } from './platform/desktop-ipc-registry';
import type { ContractArgs } from './platform/ipc-args';
import type { Handlers } from './platform/ipc-contract';

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export const clipboardArgs = {
  /** PNG bytes, e.g. a diagram the user copies as an image. */
  writeImage: Schema.Tuple([
    Schema.Uint8Array.check(
      Schema.makeFilter((png) => PNG_SIGNATURE.every((byte, at) => png[at] === byte), {
        expected: 'PNG bytes',
      })
    ),
  ]),
  writeText: Schema.Tuple([Schema.String]),
} satisfies ContractArgs<typeof clipboardContract>;

export interface ClipboardLike {
  writeImage: (png: Uint8Array) => Promise<void>;
  writeText: (text: string) => Promise<void>;
}

interface ClipboardIpcDependencies {
  clipboard: ClipboardLike;
}

/**
 * Main-side handlers for the clipboard contract. The dispatcher decodes the
 * arguments with `clipboardArgs` (a malformed payload never reaches here); a
 * clipboard write rejection settles as the boundary failure taxonomy.
 */
export function createClipboardIpcHandlers({
  clipboard,
}: ClipboardIpcDependencies): Handlers<typeof clipboardContract> {
  return {
    writeImage: (png) =>
      settleIpcResult({ category: 'clipboard', code: 'clipboard.write-failed' }, () =>
        clipboard.writeImage(png)
      ),
    writeText: (text) =>
      settleIpcResult({ category: 'clipboard', code: 'clipboard.write-failed' }, () =>
        clipboard.writeText(text)
      ),
  };
}
