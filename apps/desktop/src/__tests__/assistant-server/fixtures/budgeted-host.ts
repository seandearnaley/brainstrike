import {
  DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
  type RuntimeSubagentSettings,
} from '@brainstrike/assistant-contract/subagent-settings';
import type { DelegatedConversationDatabase } from '@brainstrike/db';
import { createDesktopDelegatedConversationHost } from '../../../assistant-server/delegated-conversation-host';

/**
 * The tree limits the admission suites exercise (three levels, eight
 * invocations, a 131,072-token tree, two runnable operations). They are
 * request SETTINGS, so the suites pin them here rather than inherit defaults
 * that are sized for long-horizon work, not for small, exact races.
 */
export const BUDGETED_HOST_SETTINGS: RuntimeSubagentSettings = Object.freeze({
  ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
  maxConcurrentWork: 2,
  maxDepth: 3,
  maxInvocations: 8,
  maxTreeOutputTokens: 131_072,
});

/**
 * A STREAMING leg's host: it carries `BUDGETED_HOST_SETTINGS`, so it can OPEN
 * the turn's budget row (`lockBudget`). A leg without settings can only read a
 * row an earlier leg stored — the case
 * `delegated-budget-settings.integration.test.ts` covers on its own.
 */
export function createBudgetedHost(
  database: DelegatedConversationDatabase,
  hostRunId: string,
  prepareInputContext?: Parameters<typeof createDesktopDelegatedConversationHost>[2]
): ReturnType<typeof createDesktopDelegatedConversationHost> {
  return createDesktopDelegatedConversationHost(
    database,
    hostRunId,
    prepareInputContext,
    undefined,
    BUDGETED_HOST_SETTINGS
  );
}
