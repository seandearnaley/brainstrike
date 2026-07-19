/**
 * Tool-lifecycle hook runner contract (platform-neutral — NO node imports).
 *
 * The agent package composes hooks into the tool-execute seam via
 * {@link AgentHookRunner}; the desktop server supplies the concrete
 * implementation over its Node-only HookManager. Hooks REFINE, never widen:
 * a PreToolUse hook can BLOCK an already-permitted tool but can never allow a
 * denied/ask tool (the permission gate runs upstream of `execute`).
 */

export interface HookToolGateResult {
  readonly additionalContext?: string;
  readonly decision: 'allow' | 'block';
  readonly reason?: string;
}

export interface AgentHookRunner {
  postToolUse(input: {
    readonly toolName: string;
    readonly toolInput: unknown;
    readonly toolOutput: unknown;
    readonly toolError: boolean;
  }): Promise<{ readonly additionalContext?: string }>;
  preToolUse(toolName: string, toolInput: unknown): Promise<HookToolGateResult>;
}

/**
 * The structured result returned in place of a tool's output when a PreToolUse
 * hook blocks it. Recognized by `isGuardedToolError` (shared `error.code`
 * union) so the untouched tool-event mapper renders it as a FAILED tool event.
 */
export interface HookBlockedToolError {
  readonly error: {
    readonly code: 'tool_blocked_by_hook';
    readonly message: string;
    readonly toolName: string;
  };
  readonly ok: false;
  readonly reason?: string;
}

/** Cap on PostToolUse `additionalContext` merged into a tool result (chars). */
export const HOOK_ADDITIONAL_CONTEXT_CHAR_BUDGET = 2000;
/**
 * Explicit envelope used to keep PostToolUse control metadata separate from
 * every domain result shape until the projection layer consumes it. The JSON
 * shape stays serializable for Mastra, but readers additionally require
 * membership in the private in-memory provenance set below. Ordinary MCP/native
 * JSON output therefore cannot forge control metadata by copying identifiers
 * or reflective object properties.
 */
export const HOOK_RESULT_ENVELOPE_FIELD = '__brainstrikeHookResultEnvelope';
export const HOOK_RESULT_ENVELOPE_KIND = 'brainstrike.post-tool-result.v1';
const HOOK_RESULT_ENVELOPE_PROVENANCE = new WeakSet<object>();

export interface HookResultEnvelope {
  readonly additionalContext: string;
  readonly result: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function createHookResultEnvelope(
  result: unknown,
  additionalContext: string
): Record<string, unknown> {
  const carrier = {
    [HOOK_RESULT_ENVELOPE_FIELD]: {
      additionalContext,
      kind: HOOK_RESULT_ENVELOPE_KIND,
      result,
    },
  };
  HOOK_RESULT_ENVELOPE_PROVENANCE.add(carrier);
  return carrier;
}

/**
 * Read a Brainstrike-minted PostToolUse carrier without interpreting a
 * domain-owned lookalike. Shape checks keep the protocol strict; private
 * WeakSet membership proves in-process provenance before any field can affect
 * model, display, or transcript output.
 */
export function readHookResultEnvelope(value: unknown): HookResultEnvelope | undefined {
  if (!isRecord(value)) {
    return;
  }
  if (!HOOK_RESULT_ENVELOPE_PROVENANCE.has(value)) {
    return;
  }
  const outerKeys = Object.keys(value);
  if (
    outerKeys.length !== 1 ||
    outerKeys[0] !== HOOK_RESULT_ENVELOPE_FIELD ||
    !isRecord(value[HOOK_RESULT_ENVELOPE_FIELD])
  ) {
    return;
  }
  const envelope = value[HOOK_RESULT_ENVELOPE_FIELD];
  const envelopeKeys = Object.keys(envelope);
  const additionalContext = envelope['additionalContext'];
  const isHookEnvelope =
    envelopeKeys.length === 3 &&
    envelopeKeys.every(
      (key) => key === 'additionalContext' || key === 'kind' || key === 'result'
    ) &&
    envelope['kind'] === HOOK_RESULT_ENVELOPE_KIND &&
    typeof additionalContext === 'string' &&
    additionalContext.length > 0 &&
    Object.hasOwn(envelope, 'result');
  if (!isHookEnvelope) {
    return;
  }
  return {
    additionalContext,
    result: envelope['result'],
  };
}
