import { type BoundaryTransport, createBoundaryCapability } from './boundary-result.ts';

/**
 * What a client may know of the host's Sign in with ChatGPT (ADR-0038): a
 * state and the account's email. Tokens stay in the host process.
 */
export type ChatGptSignInStatus =
  | { readonly state: 'signing_in' }
  | {
      /** The registered account a sign-in would continue as. */
      readonly email?: string | undefined;
      readonly state: 'signed_out';
    }
  | {
      readonly email?: string | undefined;
      /**
       * On the answer to the sign-in that registered this account, and never
       * again: OpenAI asks for one confirmation that the plan is now in use.
       */
      readonly firstSignIn?: boolean | undefined;
      readonly state: 'signed_in';
    };

/** Where the user reviews and limits what an app spends of their ChatGPT plan. */
export const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage';

/**
 * The desktop preload's `window.chatGptSignIn` capability. A refused or failed
 * call rejects with the host's boundary failure; no method carries a token
 * either way. The desktop contract
 * (`apps/desktop/src/ipc-domains/chatgpt-sign-in.contract.ts`) derives the
 * exposed object and pins it to this interface at compile time.
 */
export interface ChatGptSignInBridge {
  /** Ends a sign-in that is waiting for the browser. */
  readonly cancel: () => Promise<void>;
  /** Resolves once the browser sign-in finishes. `newAccount` registers another account or workspace. */
  readonly signIn: (newAccount: boolean) => Promise<ChatGptSignInStatus>;
  /** `revoked: false`: the tokens are gone here, but OpenAI did not confirm ending the session. */
  readonly signOut: () => Promise<{ readonly revoked: boolean }>;
  /** `settled` answers once no sign-in is waiting for the browser. */
  readonly status: (settled: boolean) => Promise<ChatGptSignInStatus>;
}

/** `null` where no host can open a browser to sign in: the capability is absent. */
export function resolveChatGptSignInBridge(): ChatGptSignInBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  // Read structurally: the desktop declares this window key from its own contract.
  const transport = (
    window as unknown as { chatGptSignIn?: BoundaryTransport<ChatGptSignInBridge> }
  ).chatGptSignIn;
  return transport ? createBoundaryCapability(transport) : null;
}
