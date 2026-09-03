/**
 * Capability resolution for the `window.mcp` members the composer's MCP prompt
 * affordance needs (BST-1592).
 *
 * Desktop-only by construction: the visible-UI preload exposes the
 * `mcp:content:*` bridge plus the revisioned host status channels; web has no
 * preload, so `resolveMcpPromptBridge()` reports `unsupported` and the
 * affordance is never constructed. There is no `isElectron()` branch anywhere.
 *
 * Lives beside the hook/host so the component modules export only components
 * (react-refresh) and so the required-member set can be pinned by tests.
 */
import type {
  ConfiguredMcpServerId,
  McpHostOperationResult,
  McpHostSnapshot,
  McpHostWatchEvent,
} from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';

const logger = createLogger('McpPromptBridge');

/**
 * One connected server generation a content request is authorized against.
 * Mirrors the assistant-service content application port's authority
 * structurally; app-shell depends only on assistant-contract.
 */
export interface McpPromptAuthority {
  readonly configuredServerId: ConfiguredMcpServerId;
  readonly generation: number;
}
/** The `prompts/get` payload the renderer sends (main forces the operation type). */
export interface McpPromptGetRequest {
  readonly arguments?: Readonly<Record<string, string>> | undefined;
  readonly authority: McpPromptAuthority;
  readonly name: string;
}
/** The `completion/complete` payload the renderer sends for one prompt argument. */
export interface McpPromptCompleteRequest {
  readonly argument: { readonly name: string; readonly value: string };
  readonly authority: McpPromptAuthority;
  readonly context?: { readonly arguments: Readonly<Record<string, string>> } | undefined;
  readonly ref: { readonly name: string; readonly type: 'ref/prompt' };
}
export type McpPromptGetResult = Extract<McpHostOperationResult, { type: 'prompts/get' }>;
export type McpPromptCompleteResult = Extract<
  McpHostOperationResult,
  { type: 'completion/complete' }
>;

export interface McpPromptBridge {
  readonly complete: (request: McpPromptCompleteRequest) => Promise<McpPromptCompleteResult>;
  readonly getPrompt: (request: McpPromptGetRequest) => Promise<McpPromptGetResult>;
  readonly getServerStatusSnapshot: () => Promise<McpHostSnapshot>;
  readonly onServerStatusUpdated: (
    callback: (event: McpHostWatchEvent) => void
  ) => (() => void) | undefined;
}

// Compile-time exact-set proof: excess or missing keys fail the build, so the
// runtime pin can never drift from the interface.
const MCP_PROMPT_BRIDGE_REQUIRED_METHOD_SET = {
  complete: true,
  getPrompt: true,
  getServerStatusSnapshot: true,
  onServerStatusUpdated: true,
} as const satisfies Record<keyof McpPromptBridge, true>;

/**
 * Every `window.mcp` member the affordance requires. All four must be present:
 * a partial bridge disables the whole surface rather than degrading it.
 */
export const MCP_PROMPT_BRIDGE_REQUIRED_METHODS = Object.keys(
  MCP_PROMPT_BRIDGE_REQUIRED_METHOD_SET
) as readonly (keyof McpPromptBridge)[];

/**
 * Why the affordance is or is not available. "This runtime has no prompt bridge"
 * and "this runtime has a BROKEN prompt bridge" are different states and must
 * not share a code path: the first is web (and any host packaged without the
 * content members), a legitimately unsupported capability that stays quiet; the
 * second is a preload/packaging defect, which AGENTS.md requires to surface
 * visibly rather than degrade into something indistinguishable from web.
 */
export type McpPromptBridgeResolution =
  | { readonly bridge: McpPromptBridge; readonly status: 'ready' }
  | { readonly missing: readonly (keyof McpPromptBridge)[]; readonly status: 'malformed' }
  | { readonly status: 'unsupported' };

/**
 * Resolve the prompt members of `window.mcp`.
 *
 * `unsupported` when there is no bridge at all (web/SSR) or when the host
 * exposes `window.mcp` with NONE of the content members (a preload manifest that
 * legitimately carries only the config members). `malformed` when SOME but not
 * all are present — a partial bridge can never be used, and the caller must say
 * so out loud instead of silently presenting web's empty surface.
 */
export function resolveMcpPromptBridge(): McpPromptBridgeResolution {
  if (typeof window === 'undefined') {
    return { status: 'unsupported' };
  }
  const candidate = (window as Window & { mcp?: Partial<McpPromptBridge> }).mcp;
  if (!candidate) {
    return { status: 'unsupported' };
  }
  const missing = MCP_PROMPT_BRIDGE_REQUIRED_METHODS.filter(
    (method) => typeof candidate[method] !== 'function'
  );
  if (missing.length === MCP_PROMPT_BRIDGE_REQUIRED_METHODS.length) {
    // No content bridge at all (a host that exposes only the config members).
    return { status: 'unsupported' };
  }
  if (missing.length > 0) {
    logger.error('window.mcp prompt bridge is malformed; composer MCP prompts disabled', {
      missing,
    });
    return { missing, status: 'malformed' };
  }
  return { bridge: candidate as McpPromptBridge, status: 'ready' };
}
