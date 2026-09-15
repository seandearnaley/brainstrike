import { useAui, useAuiState } from '@assistant-ui/react';
import {
  isToolRiskCategory,
  type ToolRiskCategory,
} from '@brainstrike/assistant-contract/tool-metadata';
import { createLogger } from '@brainstrike/logging';
import { Timer } from 'lucide-react';
import { use, useState } from 'react';
import { ActiveThreadKeyContext } from './active-thread-key-context';
import { useAnsweredApprovals } from './answered-approvals-index';
import { buildApprovalDecisionMessage } from './approval-decision-message';
import {
  RISK_CATEGORY_GRANT_NOUN,
  RISK_CATEGORY_GRANT_NOUN_SINGULAR,
} from './approval-notice-status';
import type { ApprovalCategoryKey } from './approval-presentation';
import { usePendingApprovalsByCategory } from './approval-presentation-context';
import { submitDecisionOrQueue } from './decision-dispatch';
import { useLiveDecisionTransport } from './live-decision-context';
import { useToolApprovalGrants } from './tool-approval-grant-context';

const logger = createLogger('ApprovalQueueStrip');

const CATEGORY_PREFIX = 'category:';

function readCategory(key: ApprovalCategoryKey): ToolRiskCategory | null {
  if (!key.startsWith(CATEGORY_PREFIX)) {
    return null;
  }
  const category = key.slice(CATEGORY_PREFIX.length);
  return isToolRiskCategory(category) ? category : null;
}

function countLabel(category: ToolRiskCategory, count: number): string {
  return `${count} ${count === 1 ? RISK_CATEGORY_GRANT_NOUN_SINGULAR[category] : RISK_CATEGORY_GRANT_NOUN[category]}`;
}

/**
 * The approvals strip at the composer: while a leg runs (or after it parks),
 * the pending count per category and one click that answers the whole
 * category. Records the session grant FIRST, then submits ONE approve for
 * the first pending approval of that category — the runtime answers the
 * siblings (PARKED SIBLINGS on an idle thread, `allowedBySnapshot` on a live
 * leg) and streams `tool-approval-answered` per sibling, which the index
 * turns into rows. Never N decisions: the ledger permits one active claim
 * per root. Grants are capability-gated exactly like the card's buttons: no
 * `ToolApprovalGrantProvider` → counts only. Non-policy pauses (`tool:*`
 * buckets) are never grantable and are not listed here; their cards stay.
 */
export function ApprovalQueueStrip() {
  const pending = usePendingApprovalsByCategory();
  const index = useAnsweredApprovals();
  const grants = useToolApprovalGrants();
  const deliverLive = useLiveDecisionTransport();
  const aui = useAui();
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const threadKey = use(ActiveThreadKeyContext);
  const [inFlight, setInFlight] = useState<ReadonlySet<ToolRiskCategory>>(() => new Set());

  const entries = [...pending].flatMap(([key, keys]) => {
    const category = readCategory(key);
    return category !== null && keys.length > 0 ? [{ category, keys }] : [];
  });
  if (entries.length === 0) {
    return null;
  }
  const total = entries.reduce((sum, entry) => sum + entry.keys.length, 0);

  const allowCategory = (category: ToolRiskCategory, keys: readonly string[]): void => {
    const firstKey = keys[0];
    const first = firstKey === undefined ? undefined : index.requests.get(firstKey);
    if (!(grants && first)) {
      return;
    }
    setInFlight((current) => new Set(current).add(category));
    // Grant FIRST, then the decision — if the decision fails the grant is
    // recorded and the next leg is already allowed (the card's own ordering).
    grants.grantCategoryForSession(category);
    const decision = buildApprovalDecisionMessage(first.request, 'approve');
    submitDecisionOrQueue({
      append: (message) => aui.thread().append(message),
      deliverLive,
      identityKey: decision.identityKey,
      isRunning,
      message: decision.message,
      text: decision.text,
      threadKey,
    })
      .catch((error: unknown) => {
        logger.warn('Failed to deliver the category grant decision', { category, error });
      })
      .finally(() => {
        setInFlight((current) => {
          const next = new Set(current);
          next.delete(category);
          return next;
        });
      });
  };

  return (
    <div
      aria-live="polite"
      className="bs-approval-strip"
      data-testid="approval-queue-strip"
      role="status"
    >
      <span className="bs-approval-strip-label">
        {total === 1 ? '1 approval waiting' : `${total} approvals waiting`}
      </span>
      {entries.map(({ category, keys }) => (
        <span className="bs-approval-strip-category" key={category}>
          <span data-testid={`approval-strip-count-${category}`}>
            {countLabel(category, keys.length)}
          </span>
          {grants ? (
            <button
              aria-label={`Allow ${RISK_CATEGORY_GRANT_NOUN[category]} this session for the ${keys.length} waiting ${keys.length === 1 ? 'approval' : 'approvals'}`}
              className="bs-approval-strip-grant"
              data-testid={`approval-strip-grant-${category}`}
              disabled={inFlight.has(category)}
              onClick={() => allowCategory(category, keys)}
              title={`Allow all ${RISK_CATEGORY_GRANT_NOUN[category]} until the app reloads and answer the waiting ${RISK_CATEGORY_GRANT_NOUN[category]}`}
              type="button"
            >
              <Timer aria-hidden="true" className="size-3" />
              Allow {RISK_CATEGORY_GRANT_NOUN[category]} this session
            </button>
          ) : null}
        </span>
      ))}
    </div>
  );
}
