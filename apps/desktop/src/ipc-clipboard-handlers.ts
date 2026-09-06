import type { clipboardContract } from './ipc-domains/clipboard.contract';
import { type Handlers, ipcFailure, ipcOk } from './platform/ipc-contract';

export interface ClipboardLike {
  writeText: (text: string) => void;
}

interface ClipboardIpcDependencies {
  clipboard: ClipboardLike;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Main-side handlers for the clipboard contract. Input validation lives in
 * the contract's `parseArgs` (a non-string payload never reaches here); a
 * clipboard write throw settles as the `IpcResult` failure taxonomy.
 */
export function createClipboardIpcHandlers({
  clipboard,
}: ClipboardIpcDependencies): Handlers<typeof clipboardContract> {
  return {
    writeText: (text) => {
      try {
        clipboard.writeText(text);
        return ipcOk(undefined);
      } catch (error) {
        return ipcFailure('clipboard', 'write_failed', toErrorMessage(error));
      }
    },
  };
}
