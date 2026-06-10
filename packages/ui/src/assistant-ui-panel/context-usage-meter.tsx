/**
 * ContextUsageMeter — thread context usage bar shown above the composer.
 *
 * Displays tokens used vs. the effective input budget (≤ contextWindow - output
 * reservation). Sources usage from the zustand store (exact, post-turn) and falls
 * back to a heuristic estimate when no exact value has been recorded yet.
 *
 * Threshold states (fraction of effectiveInputBudget):
 *   ok      < 75%
 *   warning ≥ 75%
 *   critical ≥ 90% → shows windowing notice
 */
import {
  countTokensHeuristic,
  formatTokenCount,
} from '@brainstrike/utils/token-counting-heuristics';
import type { FC } from 'react';
import { cn } from '../lib/utils';
import { useContextUsageStore } from './context-usage-store';

export interface ContextUsageMeterProps {
  /** Full model context window size. Meter is hidden when absent. */
  contextWindow: number | undefined;
  /** Effective input budget (contextWindow − output reservation). Meter is hidden when absent. */
  effectiveInputBudget: number | undefined;
  /** Heuristic token estimate to display before exact usage is recorded. */
  estimatedTokens?: number | undefined;
  /** Thread key — MUST match the key used by recordUsage writers (same as threadKey prop on AssistantUiPanel). Falls back to 'active'. */
  threadKey?: string | undefined;
}

type UsageState = 'ok' | 'warning' | 'critical';

function resolveUsageState(used: number, effectiveInputBudget: number): UsageState {
  const ratio = used / effectiveInputBudget;
  if (ratio >= 0.9) {
    return 'critical';
  }
  if (ratio >= 0.75) {
    return 'warning';
  }
  return 'ok';
}

/** Strip the trailing " tokens" suffix from formatTokenCount output for compact display. */
function formatCompact(count: number): string {
  return formatTokenCount(count).replace(' tokens', '');
}

export const ContextUsageMeter: FC<ContextUsageMeterProps> = ({
  threadKey,
  contextWindow,
  effectiveInputBudget,
  estimatedTokens,
}) => {
  const key = threadKey ?? 'active';
  const usage = useContextUsageStore((s) => s.usageByThread[key]);

  // Render nothing when we have no denominator.
  if (!(contextWindow && effectiveInputBudget)) {
    return null;
  }

  // Determine the token count and whether it's an estimate.
  let usedTokens: number;
  let isEstimated: boolean;

  if (usage) {
    usedTokens = usage.inputTokens + usage.outputTokens;
    isEstimated = false;
  } else if (estimatedTokens !== undefined && estimatedTokens > 0) {
    usedTokens = estimatedTokens;
    isEstimated = true;
  } else {
    // No usage and no estimate — still show a zero meter so the denominator is visible.
    usedTokens = 0;
    isEstimated = false;
  }

  const state = resolveUsageState(usedTokens, effectiveInputBudget);
  const percentage = Math.min(100, (usedTokens / effectiveInputBudget) * 100);

  return (
    <div
      className={cn(
        'mx-3 mt-1.5 mb-1 rounded-lg border px-3 py-1.5 text-xs',
        state === 'critical'
          ? 'border-destructive/40 bg-destructive/5'
          : state === 'warning'
            ? 'border-amber-500/30 bg-amber-50/30 dark:bg-amber-950/20'
            : 'border-border/50 bg-muted/20'
      )}
      data-state={state}
      data-testid="context-usage-meter"
    >
      {/* Token counts row */}
      <div className="flex items-center justify-between gap-2">
        <span
          className={cn(
            'tabular-nums',
            state === 'critical'
              ? 'text-destructive'
              : state === 'warning'
                ? 'text-amber-600 dark:text-amber-400'
                : 'text-muted-foreground'
          )}
        >
          {formatCompact(usedTokens)} / {formatTokenCount(contextWindow)}
        </span>
        {isEstimated && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground/70 uppercase tracking-wide">
            estimated
          </span>
        )}
      </div>

      {/* Progress bar */}
      <div className="mt-1 h-0.5 overflow-hidden rounded-full bg-border/50">
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-300',
            state === 'critical'
              ? 'bg-destructive/70'
              : state === 'warning'
                ? 'bg-amber-500/70'
                : 'bg-muted-foreground/40'
          )}
          style={{ width: `${percentage}%` }}
        />
      </div>

      {/* Critical windowing notice */}
      {state === 'critical' && (
        <p className="mt-1 text-[11px] text-destructive/80">
          Older messages are summarized out of context.
        </p>
      )}
    </div>
  );
};

ContextUsageMeter.displayName = 'ContextUsageMeter';

/**
 * Wrapper that lives INSIDE the AssistantRuntimeProvider tree.
 * Computes a heuristic token estimate from the current thread messages via
 * useAuiState, then renders ContextUsageMeter with it.
 *
 * Kept separate from ContextUsageMeter so the base component stays testable
 * without an assistant-ui context.
 */
export interface ThreadContextMeterProps {
  contextWindow: number | undefined;
  effectiveInputBudget: number | undefined;
  threadKey: string | undefined;
}

// Lazy import: useAuiState is only available inside an AssistantRuntimeProvider.
// We import it at the top to keep the module graph static but we only CALL it
// inside ThreadContextMeterInner, which is always mounted inside the provider.
import { useAuiState } from '@assistant-ui/react';
import { useMemo } from 'react';

export const ThreadContextMeter: FC<ThreadContextMeterProps> = ({
  contextWindow,
  effectiveInputBudget,
  threadKey,
}) => {
  // Access all messages to build a heuristic token estimate.
  const messages = useAuiState((s) => s.thread.messages);

  const estimatedTokens = useMemo(() => {
    let total = 0;
    for (const msg of messages) {
      const parts = (msg as unknown as { parts?: ReadonlyArray<{ type?: string; text?: string }> })
        .parts;
      if (!Array.isArray(parts)) {
        continue;
      }
      for (const part of parts) {
        if (part.type === 'text' && typeof part.text === 'string') {
          total += countTokensHeuristic(part.text);
        }
      }
    }
    return total;
  }, [messages]);

  return (
    <ContextUsageMeter
      contextWindow={contextWindow}
      effectiveInputBudget={effectiveInputBudget}
      estimatedTokens={estimatedTokens > 0 ? estimatedTokens : undefined}
      threadKey={threadKey}
    />
  );
};

ThreadContextMeter.displayName = 'ThreadContextMeter';
