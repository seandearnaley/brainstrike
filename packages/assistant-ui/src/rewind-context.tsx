import { createContext, type ReactNode, use } from 'react';

/** What the assistant panel knows about a rewind target when it raises one. */
export interface RewindRequestFromMessage {
  /**
   * The target message's own text, so the composer can be repopulated after a
   * successful rewind (Amendment 2 — rewind-and-retry is the actual workflow).
   * `null` when the target is not a user message or carries no text: there is
   * no fallback that invents a prompt.
   */
  readonly composerText: string | null;
  readonly messageId: string;
  readonly threadId: string;
}

export interface RewindContextValue {
  /**
   * Raise the Conversation Rewind confirm modal for one message.
   *
   * `packages/ui` cannot import `packages/app-shell` (the modal reuses the
   * Changes surface's tree and diff panes, which live there), so this is a
   * capability-injection seam — PARALLEL to `ChangesReviewContext` and
   * `RunVerdictContext` — that app-shell binds once the `window.changes`
   * bridge is present.
   *
   * Raising is NOT applying: everything destructive happens behind the modal's
   * explicit scope choice and, when files conflict, its acknowledgment.
   */
  readonly requestRewind: (request: RewindRequestFromMessage) => void;
}

const RewindContext = createContext<RewindContextValue | null>(null);

export function RewindProvider({
  value,
  children,
}: {
  value: RewindContextValue | null;
  children: ReactNode;
}) {
  return <RewindContext.Provider value={value}>{children}</RewindContext.Provider>;
}

/**
 * The rewind binding, or `null` when no provider supplied one (web, or a
 * desktop build without the changes bridge) — capability gating, never a
 * disabled stub.
 */
export function useRewindContext(): RewindContextValue | null {
  return use(RewindContext);
}
