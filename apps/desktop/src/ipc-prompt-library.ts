import { ipcMain } from 'electron';
import type { PromptLibraryPort } from './agent-host-platform/prompt-library-store';
import { promptLibraryContract } from './ipc-domains/prompt-library.contract';
import {
  createDesktopIpcRegistry,
  registerDomain,
  settleIpcResult,
} from './platform/desktop-ipc-registry';
export function registerPromptLibraryIpc(store: PromptLibraryPort): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  registerDomain(registry, 'promptLibrary', promptLibraryContract, {
    request: (request) =>
      settleIpcResult({ category: 'promptLibrary', code: 'prompt_library_failed' }, () =>
        store.promptLibrary(request)
      ),
  });
  return () => registry.unregisterAll();
}
