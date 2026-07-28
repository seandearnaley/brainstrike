/**
 * Per-thread exact token usage from provider finish chunks (session-lived,
 * deliberately NOT persisted — after reload the meter falls back to the
 * heuristic estimate until the next turn reports exact usage).
 *
 * The stored value is the latest provider step's prompt plus completion. Hosted
 * multi-step runs keep this provider-effective context separate from aggregate
 * input/output usage, which remains the durable billing/cost contract.
 *
 * `breakdownByThread` mirrors that lifecycle for the run-start prompt
 * breakdown (transient `brainstrike.context-breakdown` data part): the LAST
 * run's parsed breakdown, or an explicit `{ invalid: true }` for a malformed
 * wire part (surfaced by the popover, never silently dropped). Also
 * session-only — the part is never persisted, so a reload honestly has none.
 */
import type { AssistantContextBreakdownState } from '@brainstrike/assistant-contract/context-breakdown';
import { create } from 'zustand';

export interface ThreadTokenUsage {
  inputTokens: number;
  outputTokens: number;
}

interface ContextUsageState {
  breakdownByThread: Record<string, AssistantContextBreakdownState>;
  clearBreakdown: (threadId: string) => void;
  clearLiveRunUsage: (threadId: string) => void;
  clearThread: (threadId: string) => void;
  /**
   * Billed tokens accumulated from the IN-FLIGHT run's step-finish events
   * (BST-953). The thread-total readout adds this to the durable cumulative
   * figure so the number moves as the run streams; the wrapper clears it once
   * the run's durable row lands (the refreshed cumulative then includes it) —
   * clearing earlier would make the total dip and jump.
   */
  liveRunUsageByThread: Record<string, ThreadTokenUsage>;
  recordBreakdown: (threadId: string, breakdown: AssistantContextBreakdownState) => void;
  recordLiveStepUsage: (threadId: string, step: ThreadTokenUsage) => void;
  recordUsage: (threadId: string, usage: ThreadTokenUsage) => void;
  usageByThread: Record<string, ThreadTokenUsage>;
}

export const useContextUsageStore = create<ContextUsageState>((set) => ({
  breakdownByThread: {},
  // Drops a thread's stale breakdown WITHOUT touching its usage. Used when a
  // turn's transport structurally cannot emit a fresh breakdown (the
  // in-renderer local runtime, capability-absent by design): without this a
  // hosted turn's breakdown would keep rendering in the popover next to a
  // later local turn's freshly updated exact usage — a misleading mix of one
  // turn's category rows with another turn's totals.
  clearBreakdown: (threadId) =>
    set((state) => {
      if (!(threadId in state.breakdownByThread)) {
        return state;
      }
      const { [threadId]: _removedBreakdown, ...breakdownRest } = state.breakdownByThread;
      return { breakdownByThread: breakdownRest };
    }),
  clearLiveRunUsage: (threadId) =>
    set((state) => {
      if (!(threadId in state.liveRunUsageByThread)) {
        return state;
      }
      const { [threadId]: _removedLive, ...liveRest } = state.liveRunUsageByThread;
      return { liveRunUsageByThread: liveRest };
    }),
  clearThread: (threadId) =>
    set((state) => {
      const { [threadId]: _removedUsage, ...usageRest } = state.usageByThread;
      const { [threadId]: _removedBreakdown, ...breakdownRest } = state.breakdownByThread;
      const { [threadId]: _removedLive, ...liveRest } = state.liveRunUsageByThread;
      return {
        breakdownByThread: breakdownRest,
        liveRunUsageByThread: liveRest,
        usageByThread: usageRest,
      };
    }),
  liveRunUsageByThread: {},
  recordBreakdown: (threadId, breakdown) =>
    // The parse already happened at the wire boundary (the writer stores either
    // a valid breakdown or the explicit invalid marker) — the store records
    // both so a malformed part stays VISIBLE in the popover.
    set((state) => ({
      breakdownByThread: { ...state.breakdownByThread, [threadId]: breakdown },
    })),
  recordLiveStepUsage: (threadId, step) => {
    const isUsable =
      Number.isFinite(step.inputTokens) &&
      Number.isFinite(step.outputTokens) &&
      step.inputTokens >= 0 &&
      step.outputTokens >= 0 &&
      step.inputTokens + step.outputTokens > 0;
    if (!isUsable) {
      return; // empty or malformed step usage — nothing to accumulate
    }
    set((state) => {
      const previous = state.liveRunUsageByThread[threadId] ?? { inputTokens: 0, outputTokens: 0 };
      return {
        liveRunUsageByThread: {
          ...state.liveRunUsageByThread,
          [threadId]: {
            inputTokens: previous.inputTokens + step.inputTokens,
            outputTokens: previous.outputTokens + step.outputTokens,
          },
        },
      };
    });
  },
  recordUsage: (threadId, usage) => {
    const isUsable =
      usage.inputTokens >= 0 &&
      usage.outputTokens >= 0 &&
      (usage.inputTokens > 0 || usage.outputTokens > 0);
    if (!isUsable) {
      return; // omitted (0/0) or malformed (negative) usage — keep prior value/provenance
    }
    set((state) => ({
      usageByThread: { ...state.usageByThread, [threadId]: usage },
    }));
  },
  usageByThread: {},
}));

/**
 * Clears all per-thread usage (session reset / factory reset). Also used by tests.
 */
export function resetContextUsageStore(): void {
  useContextUsageStore.setState({
    breakdownByThread: {},
    liveRunUsageByThread: {},
    usageByThread: {},
  });
}
