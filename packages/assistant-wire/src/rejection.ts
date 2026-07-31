/**
 * The assistant POST rejection wire contract (BST-978), extracted from
 * `@brainstrike/assistant-service` so both transports and their clients share
 * one shape without importing a server package.
 */

/**
 * Initialization stage that produced a rejection. Serialized on the wire in
 * `AssistantRejectionPayload.stage`, so it lives with the wire contract even
 * though the stages themselves are server concepts.
 */
export type AgentStreamInitializationStage =
  | 'native_tool_preferences'
  | 'provider_model_bootstrap'
  | 'stream_construction'
  | 'workspace_root_resolution';

/**
 * Payload shape for a rejected assistant POST (BST-972 A4). `message` is
 * OPTIONAL — unlike `respondJson`'s payload — because the `empty_prompt`
 * rejection is deliberately message-less on the wire and must stay
 * byte-identical.
 */
export interface AssistantRejectionPayload {
  readonly code?: string;
  readonly correlationId?: string;
  readonly error: string;
  readonly message?: string;
  readonly provider?: string;
  readonly reason?: string;
  readonly stage?: AgentStreamInitializationStage;
}

/**
 * A rejected assistant POST, returned by request preparation instead of being
 * written to the response there — the transport maps it (BST-972 A4).
 */
export interface AssistantPostRejection {
  /** Close the connection after responding (the 413 body-limit case). */
  readonly closeConnection?: true;
  readonly payload: AssistantRejectionPayload;
  readonly status: number;
}
