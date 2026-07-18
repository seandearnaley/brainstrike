/**
 * Per-thread exact token usage from provider finish chunks (session-lived,
 * deliberately NOT persisted — after reload the meter falls back to the
 * heuristic estimate until the next turn reports exact usage).
 *
 * The stored value is the LAST turn's usage: the next prompt's size ≈ previous
 * prompt + previous output, so inputTokens + outputTokens is the standard
 * context-meter baseline (one-turn-lag estimate; spec §2).
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
  clearThread: (threadId: string) => void;
  recordBreakdown: (threadId: string, breakdown: AssistantContextBreakdownState) => void;
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
  clearThread: (threadId) =>
    set((state) => {
      const { [threadId]: _removedUsage, ...usageRest } = state.usageByThread;
      const { [threadId]: _removedBreakdown, ...breakdownRest } = state.breakdownByThread;
      return { breakdownByThread: breakdownRest, usageByThread: usageRest };
    }),
  recordBreakdown: (threadId, breakdown) =>
    // The parse already happened at the wire boundary (the writer stores either
    // a valid breakdown or the explicit invalid marker) — the store records
    // both so a malformed part stays VISIBLE in the popover.
    set((state) => ({
      breakdownByThread: { ...state.breakdownByThread, [threadId]: breakdown },
    })),
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
  useContextUsageStore.setState({ breakdownByThread: {}, usageByThread: {} });
}
