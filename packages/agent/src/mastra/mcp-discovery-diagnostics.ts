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
import type { StreamChunk } from '../types';
import { makeRunDetailEventChunk } from './stream-run-event-chunks';

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

const MCP_DISCOVERY_SKIP_RUN_EVENT_KIND = 'mcp.tools.unavailable' as const;

/**
 * One row per ACTUAL failure, always `status: 'failed'`.
 *
 * Never `'running'`: nothing is in flight, so there is no span to close out and
 * the row can never spin (the assistant-ui pairing contract files this kind
 * under NEVER_RUNNING, and its own comment notes that it cannot verify the
 * classification against the emitter — `mcp-discovery-run-events.spec.ts` does).
 * Never `'info'` either: the `worktree.*` breadcrumbs use `'info'` for
 * operations that SUCCEEDED, and this records a configured capability that did
 * not load.
 */
export function makeMcpDiscoverySkipChunks(skips: readonly McpDiscoverySkip[]): StreamChunk[] {
  return skips.map((skip) => {
    const isClientScope = skip.scope === 'client';
    const names = isClientScope ? (skip.serverNames ?? []).join(', ') : skip.serverName;
    return makeRunDetailEventChunk(
      MCP_DISCOVERY_SKIP_RUN_EVENT_KIND,
      'failed',
      isClientScope ? 'MCP tools unavailable' : 'MCP server tools unavailable',
      `${names} skipped for this request — ${skip.reason}`,
      {
        reason: skip.reason,
        scope: skip.scope,
        timeoutMs: skip.timeoutMs,
        ...(skip.serverName === undefined ? {} : { serverName: skip.serverName }),
        ...(skip.serverNames === undefined ? {} : { serverNames: [...skip.serverNames] }),
      }
    );
  });
}

/**
 * Yield the skip rows, then the turn.
 *
 * Called ONLY from the initial-turn seam (`createStreamIteratorFromRuntime`), so
 * the approval- and suspend-resume legs — which route through `runTurnAttempts`
 * directly — stay quiet. That scoping is load-bearing: a resume rebuilds the
 * runtime and re-runs discovery, so without it the same rows would be re-emitted
 * on every approval, which is the duplication hazard `withoutDuplicateRunStarted`
 * already exists for.
 *
 * The rows precede `run.started` because discovery genuinely happened first,
 * during runtime construction. The thread-run row is created by
 * `repository.createThreadRun` rather than by `run.started`, so they have a run
 * to attach to, and no consumer indexes on `run.started` being first.
 */
export async function* prependMcpDiscoverySkipChunks(
  skips: readonly McpDiscoverySkip[],
  turn: AsyncIterableIterator<StreamChunk>
): AsyncIterableIterator<StreamChunk> {
  for (const chunk of makeMcpDiscoverySkipChunks(skips)) {
    yield chunk;
  }
  yield* turn;
}
