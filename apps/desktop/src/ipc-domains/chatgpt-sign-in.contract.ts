/**
 * Settings › Providers: Sign in with ChatGPT (ADR-0038). Main forwards each
 * call to the agent host, which owns the browser flow and holds the tokens;
 * the renderer receives a state and an email, never a token. The derived
 * bridge is pinned to `ChatGptSignInBridge` in `@brainstrike/assistant-contract`,
 * the shape the shared Settings UI consumes. PURE: bundled into the preload and
 * imported by main.
 */
import type {
  ChatGptSignInBridge,
  ChatGptSignInStatus,
} from '@brainstrike/assistant-contract/chatgpt-sign-in';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import {
  type AssertTrue,
  type BridgeMatches,
  type Contract,
  channel,
} from '../platform/ipc-contract';

export const chatGptSignInContract = {
  cancel: channel<[], void>({ channel: DESKTOP_IPC_CHANNELS.chatGptSignIn.cancel }),
  signIn: channel<[newAccount: boolean], ChatGptSignInStatus>({
    channel: DESKTOP_IPC_CHANNELS.chatGptSignIn.signIn,
  }),
  signOut: channel<[], { readonly revoked: boolean }>({
    channel: DESKTOP_IPC_CHANNELS.chatGptSignIn.signOut,
  }),
  status: channel<[settled: boolean], ChatGptSignInStatus>({
    channel: DESKTOP_IPC_CHANNELS.chatGptSignIn.status,
  }),
} satisfies Contract;

/** @internal Compile-time assertion that the runtime contract matches its public wire types. */
export type ChatGptSignInBridgeDerivationProof = AssertTrue<
  BridgeMatches<typeof chatGptSignInContract, ChatGptSignInBridge>
>;
