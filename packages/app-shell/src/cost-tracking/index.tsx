import { Coins, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { BudgetGuardrailSettingsPanel } from './budget-settings-panel';
import { CostAggregationPanel } from './cost-aggregation-panel';
import { CostOverviewPanel } from './cost-overview-panel';
import { TaskLedgerPanel } from './task-ledger-panel';

export {
  type DailySpendState,
  type DailySpendSummary,
  type RunLedgerState,
  resolveHostDailySpend,
  TASK_LEDGER_RUN_LIMIT,
  useDailySpend,
  useRunLedger,
} from '@brainstrike/assistant-data/cost-tracking';
export { BudgetGuardrailSettingsPanel, parseCapInput } from './budget-settings-panel';
export {
  CostAggregationPanel,
  CostAggregationPanelView,
} from './cost-aggregation-panel';
export { CostOverviewPanel, CostOverviewPanelView } from './cost-overview-panel';
export {
  isRunOverCap,
  type TaskLedgerAnalyticsViewState,
  TaskLedgerPanel,
  TaskLedgerPanelView,
  type TaskLedgerRunsViewState,
} from './task-ledger-panel';
export { type CrossRootCostState, useCrossRootCost } from './use-cross-root-cost';
export { type LedgerAnalyticsState, useLedgerAnalytics } from './use-ledger-analytics';

/**
 * A settings category projection. Structurally compatible with the preferences
 * `SettingsCategory` (kept local to avoid a dependency cycle — app-shell does
 * not import the preferences settings-page-content module). Mirrors the
 * diagnostics category creator pattern.
 */
interface CostTrackingSettingsCategory {
  readonly content: ReactNode;
  readonly description?: string;
  readonly icon?: LucideIcon;
  readonly id: string;
  readonly keywords?: string[];
  readonly title: string;
}

/**
 * Create the Cost Tracking settings category. Lives in app-shell (not
 * preferences) because the cost panel depends on the durable run-usage repo +
 * cost helpers, which live here — exactly how the System Diagnostics category
 * is composed (@brainstrike/app-shell/diagnostics).
 */
export function createCostTrackingSettingsCategory(): CostTrackingSettingsCategory {
  return {
    content: (
      <div className="space-y-4">
        <CostOverviewPanel />
        <BudgetGuardrailSettingsPanel />
        <CostAggregationPanel />
        <TaskLedgerPanel />
      </div>
    ),
    description:
      'See what your assistant runs cost, split into input, cached and output tokens, by workspace, model and run.',
    icon: Coins,
    id: 'cost-tracking',
    keywords: [
      'cost',
      'tracking',
      'usage',
      'tokens',
      'spend',
      'billing',
      'price',
      'ledger',
      'runs',
      'outcomes',
      'models',
      'budget',
      'cap',
      'guardrail',
    ],
    title: 'Cost Tracking',
  };
}
