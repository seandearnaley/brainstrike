import { formatUsdCost } from '@brainstrike/utils/token-counting-heuristics';
import { PiggyBank } from 'lucide-react';
import type { ReactElement } from 'react';
import { Button } from '../button';
import { useBudgetGuardrailContext } from './budget-guardrail-context';

/**
 * Whether sending is currently blocked by the last-24h budget cap: over cap
 * AND not overridden for this session. Open (false) when no guardrail binding
 * is provided (no cap configured / no durable-spend capability). Consumed by
 * the composer input row so the Send path (button + Enter-in-textarea) is
 * disabled exactly while the blocking notice below is visible — the block is
 * NEVER silent (the notice + "Send anyway" render whenever this is true).
 */
export function useBudgetSendGate(): boolean {
  const context = useBudgetGuardrailContext();
  if (context === null) {
    return false;
  }
  return context.status.overCap && !context.overridden;
}

/**
 * Compact last-24h burn-down chip for the composer shell (mounted alongside
 * the context-usage meter), plus the over-cap send notice.
 *
 * Honesty rules (mirrors the Task Ledger's honest-cost contract):
 * - the total is exact spend + registry-priced estimate; when any estimate is
 *   included the chip says "part est.";
 * - unpriced models are EXCLUDED from the total and surfaced as an explicit
 *   "+N unpriced" marker — never a fabricated price;
 * - the window is the rolling LAST 24 HOURS (deliberately timezone-free), so
 *   the copy always says "last 24h", never "today";
 * - over cap without an override shows the blocking notice with an explicit
 *   "Send anyway" (never a silent block); an active override is stated next to
 *   the chip (never a silent allow).
 */
export function BudgetGuardrailControl(): ReactElement | null {
  const context = useBudgetGuardrailContext();
  if (!context) {
    return null;
  }
  const { overridden, override, status } = context;
  const totalUsd = status.spentUsd + status.estimatedUsd;
  const totalLabel = `${formatUsdCost(totalUsd)} of ${formatUsdCost(status.capUsd)}`;
  const blocked = status.overCap && !overridden;
  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 py-0.5 text-[11px]"
      data-testid="budget-guardrail"
    >
      <span
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${
          status.overCap
            ? 'border-destructive/40 text-destructive'
            : 'border-border text-muted-foreground'
        }`}
        data-testid="budget-guardrail-chip"
        title={`Rolling last-24h assistant spend: ${formatUsdCost(status.spentUsd)} exact + ${formatUsdCost(status.estimatedUsd)} estimated, against a ${formatUsdCost(status.capUsd)} cap.`}
      >
        <PiggyBank aria-hidden="true" className="size-3" />
        Last 24h: {totalLabel}
        {status.estimatedUsd > 0 ? ' (part est.)' : ''}
      </span>
      {status.unpricedModelCount > 0 ? (
        <span
          className="text-muted-foreground"
          data-testid="budget-guardrail-unpriced"
          title="Tokens from models without a registry list price are excluded from the total — the real spend may be higher."
        >
          +{status.unpricedModelCount} unpriced model{status.unpricedModelCount === 1 ? '' : 's'}
        </span>
      ) : null}
      {blocked ? (
        <span
          className="inline-flex items-center gap-2 text-destructive"
          data-testid="budget-guardrail-blocked"
          role="status"
        >
          Last-24h budget cap reached — {totalLabel}. Sending is paused.
          <Button
            aria-label="Send anyway"
            className="h-5 px-1.5 text-[11px]"
            data-testid="budget-guardrail-override"
            onClick={override}
            size="sm"
            type="button"
            variant="outline"
          >
            Send anyway
          </Button>
        </span>
      ) : null}
      {status.overCap && overridden ? (
        <span className="text-muted-foreground" data-testid="budget-guardrail-overridden">
          Cap overridden for this session.
        </span>
      ) : null}
    </div>
  );
}
