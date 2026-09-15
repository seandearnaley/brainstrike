import { DEFAULT_RUNTIME_SUBAGENT_SETTINGS } from '@brainstrike/assistant-contract/subagent-settings';
import type { DelegatedConversationDatabase } from '@brainstrike/db';
import { createDesktopDelegatedConversationHost } from '../../../assistant-server/delegated-conversation-host';

/**
 * A STREAMING leg's host: it carries the default `RuntimeSubagentSettings`, so
 * it can OPEN the turn's budget row (`lockBudget`). A leg without settings can
 * only read a row an earlier leg stored — the case
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
    DEFAULT_RUNTIME_SUBAGENT_SETTINGS
  );
}
