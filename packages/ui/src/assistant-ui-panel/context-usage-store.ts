/**
 * Per-thread exact token usage from provider finish chunks (session-lived,
 * deliberately NOT persisted — after reload the meter falls back to the
 * heuristic estimate until the next turn reports exact usage).
 *
 * The stored value is the LAST turn's usage: the next prompt's size ≈ previous
 * prompt + previous output, so inputTokens + outputTokens is the standard
 * context-meter baseline (one-turn-lag estimate; spec §2).
 */
import { create } from 'zustand';

export interface ThreadTokenUsage {
  inputTokens: number;
  outputTokens: number;
}

interface ContextUsageState {
  clearThread: (threadId: string) => void;
  recordUsage: (threadId: string, usage: ThreadTokenUsage) => void;
  usageByThread: Record<string, ThreadTokenUsage>;
}

export const useContextUsageStore = create<ContextUsageState>((set) => ({
  usageByThread: {},
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
  clearThread: (threadId) =>
    set((state) => {
      const { [threadId]: _removed, ...rest } = state.usageByThread;
      return { usageByThread: rest };
    }),
}));

/**
 * Test-only helper.
 *
 * @internal
 */
export function resetContextUsageStore(): void {
  useContextUsageStore.setState({ usageByThread: {} });
}
