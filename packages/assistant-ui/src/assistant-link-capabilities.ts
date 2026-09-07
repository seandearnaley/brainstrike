import { createContext, use } from 'react';

/** Outcome of a link open. Named (not inline) so a future field cannot drift
 * between this contract and the host that implements it. */
export interface AssistantLinkOpenResult {
  readonly error?: string;
  readonly ok: boolean;
}

/**
 * How the assistant panel asks its host to open a link.
 *
 * Named `openLink` rather than `openExternalLink` on purpose: the panel states
 * the INTENT ("open this"), and the host decides the destination. Today that is
 * the OS browser via the validated `shell.openExternal` bridge on desktop and
 * `window.open` on web. When the in-app browser pane ships, only the host
 * implementation changes — nothing in this package moves.
 *
 * The host also owns link POLICY (which protocols may open) and the single
 * visible failure, matching the seam idiom used by the workspace bar chips.
 * That keeps one protocol allowlist per platform instead of a copy in the panel
 * that could drift from the one the main process actually enforces.
 */
export interface AssistantLinkCapabilities {
  /** Open a link. Resolves `{ ok: false, error }` on refusal or failure — the host surfaces it. Must never reject. */
  readonly openLink: (url: string) => Promise<AssistantLinkOpenResult>;
}

/** Consumed via the hook below; the provider component lives in its own module
 * so Fast Refresh keeps working (a file may not export both). */
export const AssistantLinkCapabilitiesContext = createContext<AssistantLinkCapabilities | null>(
  null
);

/** Nullable by design: an absent provider is a wiring bug that must be loud in
 * the logs, never a silent no-op click and never a licence to let the anchor
 * default navigate the renderer away from the app. */
export function useAssistantLinkCapabilities(): AssistantLinkCapabilities | null {
  return use(AssistantLinkCapabilitiesContext);
}
