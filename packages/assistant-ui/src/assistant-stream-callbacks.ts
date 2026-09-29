import type { DelegatedConversationUpdate } from './delegated-conversation-receiver';

/** Shared hosted-stream callbacks for the panel and its conversation thread. */
export interface AssistantStreamCallbacks {
  /**
   * Called with the RAW payload of each `brainstrike.child-run-usage` data
   * part (subagent / OM cycle usage, durably persisted server-side — BST-953).
   * Hosted/data-stream transport only, same seam shape as onContextBreakdown.
   */
  onChildRunUsage?: ((data: unknown) => void) | undefined;
  /**
   * Called with the RAW payload of each run-start `brainstrike.context-breakdown`
   * data part (transient prompt breakdown). Hosted/data-stream transport only —
   * the in-renderer local runtime has no breakdown channel (capability-absent),
   * so the callback is simply never wired there. The app parses the payload
   * with the contract guard (malformed → { invalid: true }) and records it in
   * the context usage store; same seam shape as onUsage.
   */
  onContextBreakdown?: ((data: unknown) => void) | undefined;
  /** Hosted/data-stream snapshots only; never wired to the in-renderer local runtime. */
  onDelegatedConversation?: ((update: DelegatedConversationUpdate) => void) | undefined;
}
