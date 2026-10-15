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
import {
  type AssistantRunEventMetadata,
  boundRunEventReason,
  MAX_RUN_EVENT_REASON_CHARS,
} from '../run-events';
import type { StreamChunk } from '../types';
import { makeRunDetailEventChunk } from '../tool-projection/stream-run-event-chunks';

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

/**
 * BST-1602's redact-then-bound treatment for a durable, rendered failure
 * reason. The implementation moved to `@brainstrike/assistant-contract`'s
 * run-event contract in BST-1737, which needs the identical control for
 * compaction failures — one copy of the redaction regexes, not two. These
 * aliases keep the MCP-side call sites and their tests reading in the loader's
 * own vocabulary; the behaviour is `boundRunEventReason`'s, unchanged.
 */
export const MAX_MCP_DISCOVERY_REASON_CHARS = MAX_RUN_EVENT_REASON_CHARS;
export const boundMcpDiscoveryReason = boundRunEventReason;

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
