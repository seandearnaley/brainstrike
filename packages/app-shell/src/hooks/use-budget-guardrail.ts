import { useAssistantBudgetPreferencesStore } from '@brainstrike/app-state/stores/assistant-budget-preferences-store';
import { useDailySpend } from '@brainstrike/assistant-data/cost-tracking';
import type { BudgetGuardrailContextValue } from '@brainstrike/assistant-ui';
import { createLogger } from '@brainstrike/logging';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAssistantThreadHostLedger } from '../assistant-thread-host-context';

const budgetGuardrailLogger = createLogger('BudgetGuardrail');

/**
 * Binds the assistant panel's budget guardrail (composer burn-down chip +
 * over-cap send gate) to the persisted daily cap preference and the derived
 * rolling last-24h spend.
 *
 * Null (guardrail absent, renders nothing) when:
 * - no daily cap is configured (feature off by default),
 * - the durable-usage capability is absent (web: no run_usage rows exist),
 * - the spend window has not loaded yet (never a premature verdict), or
 * - the spend query/parse failed — the failure is NOT silent (logged as an
 *   error below); v1 deliberately fails open here because blocking every send
 *   on a broken analytics query would be a silent BLOCK with no honest number
 *   to show. See docs/agents/assistant-persistence.md → Budget guardrails.
 *
 * `overridden` is session-lived (component state): "Send anyway" applies until
 * the assistant panel unmounts, and is never persisted.
 */
export function useBudgetGuardrailBinding(
  resourceIdOverride?: string | null
): BudgetGuardrailContextValue | null {
  const dailyCapUsd = useAssistantBudgetPreferencesStore((state) => state.dailyCapUsd);
  // Agent-host threads' committed provider calls count toward the same cap.
  const { usage: hostUsage } = useAssistantThreadHostLedger();
  const spendState = useDailySpend(resourceIdOverride, hostUsage);
  const [overridden, setOverridden] = useState(false);
  const override = useCallback(() => setOverridden(true), []);

  useEffect(() => {
    if (dailyCapUsd !== null && spendState.error) {
      budgetGuardrailLogger.error(
        'Failed to derive last-24h spend — the budget guardrail is inactive',
        { error: spendState.error }
      );
    }
  }, [dailyCapUsd, spendState.error]);

  return useMemo(() => {
    if (dailyCapUsd === null || !spendState.available || spendState.error) {
      return null;
    }
    const spend = spendState.spend;
    if (spend === null) {
      return null;
    }
    return {
      overridden,
      override,
      status: {
        capUsd: dailyCapUsd,
        estimatedUsd: spend.estimatedUsd,
        // "Cap reached" gates at the boundary: spending the full cap is the cap.
        overCap: spend.totalUsd >= dailyCapUsd,
        spentUsd: spend.exactUsd,
        unpricedModelCount: spend.unpricedModels.length,
      },
    };
  }, [dailyCapUsd, overridden, override, spendState.available, spendState.error, spendState.spend]);
}
