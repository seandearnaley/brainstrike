/**
 * MCP discovery diagnostics (BST-1602): the content-free facts a run records
 * when a configured MCP server contributed ZERO tools to it.
 *
 * Deliberately its own module rather than living in `mcp-tool-loader.ts` or
 * `stream-run-event-chunks.ts`. The loader must not decide presentation — that
 * coupling is what produced the original silent degradation, where a substring
 * heuristic over the failure reason demoted the two likeliest failures to
 * `debug` — and `stream-run-event-chunks.ts` is documented as the leaf every
 * other streaming concern depends on, so giving it an import of the MCP loader
 * would invert that dependency.
 */

/**
 * `'client'` — discovery itself failed (rejected, or lost the timeout race), so
 * EVERY configured server contributed nothing. One lost race is ONE fact, so a
 * client-scope skip names every affected server in `serverNames` rather than
 * being fanned out into one skip per server, which would report N failures
 * where one happened.
 *
 * `'server'` — exactly that one server's `listTools` failed.
 */
export type McpDiscoverySkipScope = 'client' | 'server';

export interface McpDiscoverySkip {
  readonly reason: string;
  readonly scope: McpDiscoverySkipScope;
  /** Present iff `scope === 'server'`. */
  readonly serverName?: string;
  /** Present iff `scope === 'client'`; every configured server name. */
  readonly serverNames?: readonly string[];
  readonly timeoutMs: number;
}

export const MAX_MCP_DISCOVERY_REASON_CHARS = 200;

/**
 * Bound the reason before it becomes durable run-event metadata.
 * `sanitizeAssistantRunEventMetadata` redacts by KEY, not by value, and an HTTP
 * transport error can carry a URL, so an unbounded provider string would be
 * persisted verbatim.
 */
export function boundMcpDiscoveryReason(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value);
  return raw.length <= MAX_MCP_DISCOVERY_REASON_CHARS
    ? raw
    : `${raw.slice(0, MAX_MCP_DISCOVERY_REASON_CHARS)}…`;
}
