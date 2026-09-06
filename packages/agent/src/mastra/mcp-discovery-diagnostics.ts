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
import type { AssistantRunEventMetadata } from '../run-events';
import type { StreamChunk } from '../types';
import { makeRunDetailEventChunk } from './stream-run-event-chunks';

/**
 * A discriminated union, not one shape with two optional name fields (PR #2938
 * review). The optional form let `{ scope: 'server' }` with no `serverName`
 * type-check, and the chunk builder then rendered `"undefined skipped for this
 * request"` into a DURABLE, always-visible row. Each variant now carries
 * exactly the names its branch reads, so both branches are total.
 *
 * `'client'` — discovery itself failed (rejected, or lost the timeout race), so
 * EVERY configured server contributed nothing. One lost race is ONE fact, so a
 * client-scope skip names every affected server in `serverNames` rather than
 * being fanned out into one skip per server, which would report N failures
 * where one happened.
 *
 * `'server'` — exactly that one server's `listTools` failed.
 */
export type McpDiscoverySkip =
  | {
      readonly reason: string;
      readonly scope: 'client';
      /** Every server this RUN configured (never the client's wider set). */
      readonly serverNames: readonly string[];
      readonly timeoutMs: number;
    }
  | {
      readonly reason: string;
      readonly scope: 'server';
      readonly serverName: string;
      readonly timeoutMs: number;
    };

/** Total length of a bounded reason, INCLUDING the ellipsis it may end with. */
export const MAX_MCP_DISCOVERY_REASON_CHARS = 200;

const REDACTED = '[redacted]';
/** `https://user:pass@host` — credentials in the URL's userinfo section. */
const URL_USERINFO = /(https?:\/\/)[^/\s@]+@/gi;
/** `https://host/mcp?api_key=…` — credentials in a URL query string. */
const URL_QUERY = /(https?:\/\/[^\s?]+)\?\S*/gi;

/**
 * Prepare a provider failure message for DURABLE run-event metadata and for the
 * always-visible timeline `detail`.
 *
 * Two separate jobs, and the ordering matters:
 *
 * 1. REDACT. `sanitizeAssistantRunEventMetadata` redacts by KEY, not by value,
 *    so nothing downstream inspects this string. Before BST-1602 the reason
 *    reached at most a `debug` log line; it is now persisted and rendered, so a
 *    transport error like `fetch failed: 401 for https://host/mcp?api_key=…`
 *    would be a real disclosure. Truncation does NOT prevent that — such a
 *    message is comfortably under the bound (PR #2938 review) — so URL
 *    userinfo and query strings are stripped first.
 * 2. BOUND. Only then cap the length, to keep the row small.
 *
 * Sliced by CODE POINT, not UTF-16 code unit: `slice` can split a surrogate
 * pair and put a lone surrogate into durable JSON.
 */
export function boundMcpDiscoveryReason(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value);
  const redacted = raw.replace(URL_USERINFO, `$1${REDACTED}@`).replace(URL_QUERY, `$1?${REDACTED}`);
  const points = Array.from(redacted);
  if (points.length <= MAX_MCP_DISCOVERY_REASON_CHARS) {
    return redacted;
  }
  return `${points.slice(0, MAX_MCP_DISCOVERY_REASON_CHARS - 1).join('')}…`;
}

const MCP_DISCOVERY_SKIP_RUN_EVENT_KIND = 'mcp.tools.unavailable' as const;

function describeSkip(skip: McpDiscoverySkip): {
  label: string;
  metadata: AssistantRunEventMetadata;
  names: string;
} {
  if (skip.scope === 'client') {
    return {
      label: 'MCP tools unavailable',
      metadata: {
        reason: skip.reason,
        scope: 'client',
        serverNames: [...skip.serverNames],
        timeoutMs: skip.timeoutMs,
      },
      names: skip.serverNames.join(', '),
    };
  }
  return {
    label: 'MCP server tools unavailable',
    metadata: {
      reason: skip.reason,
      scope: 'server',
      serverName: skip.serverName,
      timeoutMs: skip.timeoutMs,
    },
    names: skip.serverName,
  };
}

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
 *
 * The caller yields these INSIDE the turn generator that owns runtime disposal
 * (see `runTurnAttempts`) — never from a wrapper around it. A wrapper that
 * yielded them first could be cancelled before delegating, leaving the turn
 * generator unstarted and its `finally` — and so `runtime.dispose()` — never
 * run (PR #2938 review). Note that `.return()` on an unstarted generator does
 * NOT run its body, so no wrapper-side cleanup can fix that; the rows have to
 * live inside the generator whose disposal they depend on.
 */
export function makeMcpDiscoverySkipChunks(skips: readonly McpDiscoverySkip[]): StreamChunk[] {
  return skips.map((skip) => {
    const { label, metadata, names } = describeSkip(skip);
    return makeRunDetailEventChunk(
      MCP_DISCOVERY_SKIP_RUN_EVENT_KIND,
      'failed',
      label,
      `${names} skipped for this request — ${skip.reason}`,
      metadata
    );
  });
}
