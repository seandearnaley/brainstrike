// Is every chunk the UI was shown in the log? Each chunk is its own row, so per (thread, run) the shown chunks must be a
// prefix of the logged ones. A shown chunk is LOST when the log ends before it; MISMATCHED when the log has different
// content at its position (corruption or reordering).
import type { RunChunk } from './workload.js';

export interface ShownChunk {
  readonly c: RunChunk;
  readonly r: string;
  readonly t: string;
}

export interface ShownCheck {
  /** Committed to the log but never shown (the host died first): informational, not a loss. */
  committedNotShown: number;
  firstProblem?: string;
  lost: number;
  mismatched: number;
  shown: number;
}

const byRun = (chunks: readonly ShownChunk[]): Map<string, string[]> =>
  new Map(
    [...Map.groupBy(chunks, ({ t, r }) => `${t} ${r}`)].map(([k, v]) => [
      k,
      v.map(({ c }) => JSON.stringify(c)),
    ])
  );

export function checkShownInLog(
  shown: readonly ShownChunk[],
  logged: readonly ShownChunk[]
): ShownCheck {
  const log = byRun(logged);
  const display = byRun(shown);
  const res: ShownCheck = { committedNotShown: 0, lost: 0, mismatched: 0, shown: shown.length };
  for (const [k, seen] of display) {
    const rows = log.get(k) ?? [];
    for (const [i, c] of seen.entries()) {
      if (i >= rows.length) {
        res.lost += 1;
        res.firstProblem ??= `lost ${k} #${i}: ${c.slice(0, 80)}`;
      } else if (rows[i] !== c) {
        res.mismatched += 1;
        res.firstProblem ??= `mismatch ${k} #${i}: shown ${c.slice(0, 80)} log ${String(rows[i]).slice(0, 80)}`;
      }
    }
  }
  for (const [k, rows] of log) {
    res.committedNotShown += Math.max(0, rows.length - (display.get(k)?.length ?? 0));
  }
  return res;
}
