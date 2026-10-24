/** Shared discovery-failure facts and the canonical reason redactor. */
import { boundRunEventReason } from '../run-events.ts';

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
export const boundMcpDiscoveryReason = boundRunEventReason;
