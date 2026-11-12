import type { ChatGptSignInStatus } from '@brainstrike/assistant-contract/chatgpt-sign-in';
import { Schema } from 'effect';
import { ipcMain } from 'electron';
import { chatGptSignInContract } from './ipc-domains/chatgpt-sign-in.contract';
import {
  createDesktopIpcRegistry,
  registerDomain,
  settleIpcResult,
} from './platform/desktop-ipc-registry';
import { NoArgs } from './platform/ipc-args';

/** The agent host's Sign in with ChatGPT, as Main's private desktop client reaches it. */
export interface ChatGptSignInHandlers {
  readonly cancel: () => Promise<void>;
  readonly signIn: (newAccount: boolean) => Promise<ChatGptSignInStatus>;
  readonly signOut: () => Promise<{ readonly revoked: boolean }>;
  readonly status: (settled: boolean) => Promise<ChatGptSignInStatus>;
}

/**
 * Registers the Settings › Providers sign-in channels (ADR-0038). The host's
 * own refusal (declined, cancelled, wrong account) reaches the renderer as it
 * was written; anything else is the logged fault named here.
 */
export function registerChatGptSignInIpcHandlers(handlers: ChatGptSignInHandlers): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  const failed = { category: 'chatGptSignIn', code: 'chatgpt-sign-in.failed' };
  registerDomain(
    registry,
    'chatGptSignIn',
    chatGptSignInContract,
    {
      cancel: NoArgs,
      signIn: Schema.Tuple([Schema.Boolean]),
      signOut: NoArgs,
      status: Schema.Tuple([Schema.Boolean]),
    },
    {
      cancel: () => settleIpcResult(failed, () => handlers.cancel()),
      signIn: (newAccount) => settleIpcResult(failed, () => handlers.signIn(newAccount)),
      signOut: () => settleIpcResult(failed, () => handlers.signOut()),
      status: (settled) => settleIpcResult(failed, () => handlers.status(settled)),
    }
  );
  return () => {
    registry.unregisterAll();
  };
}
