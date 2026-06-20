import { Coins, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { CostAggregationPanel } from './cost-aggregation-panel';

export {
  CostAggregationPanel,
  CostAggregationPanelView,
} from './cost-aggregation-panel';
export { type CrossRootCostState, useCrossRootCost } from './use-cross-root-cost';

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
    id: 'cost-tracking',
    title: 'Cost Tracking',
    description: 'Review durable token usage and estimated cost per workspace root.',
    keywords: ['cost', 'tracking', 'usage', 'tokens', 'spend', 'billing', 'price'],
    icon: Coins,
    content: <CostAggregationPanel />,
  };
}
