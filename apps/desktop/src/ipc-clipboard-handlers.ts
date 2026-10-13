import type { clipboardContract } from './ipc-domains/clipboard.contract';
import { settleIpcResult } from './platform/desktop-ipc-registry';
import type { Handlers } from './platform/ipc-contract';

export interface ClipboardLike {
  writeText: (text: string) => Promise<void>;
}

interface ClipboardIpcDependencies {
  clipboard: ClipboardLike;
}

/**
 * Main-side handlers for the clipboard contract. Input validation lives in
 * the contract's `parseArgs` (a non-string payload never reaches here); a
 * clipboard write rejection settles as the `IpcResult` failure taxonomy.
 */
export function createClipboardIpcHandlers({
  clipboard,
}: ClipboardIpcDependencies): Handlers<typeof clipboardContract> {
  return {
    writeText: (text) =>
      settleIpcResult({ category: 'clipboard', code: 'clipboard.write-failed' }, () =>
        clipboard.writeText(text)
      ),
  };
}
