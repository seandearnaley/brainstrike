// Is every chunk the UI was shown in the log? (M0-A1 src/shown-check.ts.) The log stores coalesced rows (adjacent deltas
// of one part merged), so deltas are compared as per-part character streams and every other chunk as an ordered list,
// per (thread, run). A shown chunk is LOST when the log ends before it; MISMATCHED when the log has different content at
// its position (corruption or reordering).
import type { RunChunk } from '../../src/coalescer.js';

export interface ShownChunk {
  readonly c: RunChunk;
  readonly r: string;
  readonly t: string;
}

export interface ShownCheck {
  /** Committed to the log but never shown (the UI died first): informational, not a loss. */
  committedNotShown: { otherChunks: number; deltaChars: number };
  firstProblem?: string;
  lost: number;
  lostByType: Record<string, number>;
  mismatched: number;
  shown: number;
}

function deltaOf(c: RunChunk): { key: string; text: string } | null {
  switch (c.type) {
    case 'text-delta':
      return { key: `text:${String(c['id'])}`, text: String(c['delta']) };
    case 'reasoning-delta':
      return { key: `reasoning:${String(c['id'])}`, text: String(c['delta']) };
    case 'tool-input-delta':
      return { key: `tool-input:${String(c['toolCallId'])}`, text: String(c['inputTextDelta']) };
    default:
      return null;
  }
}

export function checkShownInLog(
  shown: readonly ShownChunk[],
  logged: readonly ShownChunk[]
): ShownCheck {
  interface G {
    deltas: Map<string, string>;
    other: string[];
  }
  const groups = new Map<string, G>();
  const g = (t: string, r: string): G => {
    const k = `${t}\u0000${r}`;
    let x = groups.get(k);
    if (!x) {
      x = { deltas: new Map(), other: [] };
      groups.set(k, x);
    }
    return x;
  };
  for (const { t, r, c } of logged) {
    const x = g(t, r);
    const d = deltaOf(c);
    if (d) {
      x.deltas.set(d.key, (x.deltas.get(d.key) ?? '') + d.text);
    } else {
      x.other.push(JSON.stringify(c));
    }
  }
  const res: ShownCheck = {
    committedNotShown: { deltaChars: 0, otherChunks: 0 },
    lost: 0,
    lostByType: {},
    mismatched: 0,
    shown: shown.length,
  };
  const offsets = new Map<string, number>();
  const otherIdx = new Map<string, number>();
  const problem = (s: string): void => {
    res.firstProblem ??= s;
  };
  for (const { t, r, c } of shown) {
    const gk = `${t}\u0000${r}`;
    const x = g(t, r);
    const d = deltaOf(c);
    if (d) {
      const ok = `${gk}\u0000${d.key}`;
      const start = offsets.get(ok) ?? 0;
      const end = start + d.text.length;
      offsets.set(ok, end);
      const lg = x.deltas.get(d.key) ?? '';
      if (end <= lg.length) {
        if (lg.slice(start, end) !== d.text) {
          res.mismatched++;
          problem(`delta mismatch ${t} ${d.key} @${start}`);
        }
        continue;
      }
      if (lg.slice(start) !== d.text.slice(0, Math.max(0, lg.length - start))) {
        res.mismatched++;
        problem(`delta mismatch at log end ${t} ${d.key} @${start}`);
        continue;
      }
      res.lost++;
      res.lostByType[c.type] = (res.lostByType[c.type] ?? 0) + 1;
      problem(`lost ${c.type} ${t} ${d.key} @${start}..${end} (log has ${lg.length})`);
      continue;
    }
    const i = otherIdx.get(gk) ?? 0;
    otherIdx.set(gk, i + 1);
    if (i >= x.other.length) {
      res.lost++;
      res.lostByType[c.type] = (res.lostByType[c.type] ?? 0) + 1;
      problem(`lost ${c.type} ${t} #${i}`);
      continue;
    }
    if (x.other[i] !== JSON.stringify(c)) {
      res.mismatched++;
      problem(
        `mismatch ${t} #${i}: shown ${JSON.stringify(c).slice(0, 80)} log ${String(x.other[i]).slice(0, 80)}`
      );
    }
  }
  for (const [gk, x] of groups) {
    res.committedNotShown.otherChunks += Math.max(0, x.other.length - (otherIdx.get(gk) ?? 0));
    for (const [k, s] of x.deltas) {
      res.committedNotShown.deltaChars += Math.max(
        0,
        s.length - (offsets.get(`${gk}\u0000${k}`) ?? 0)
      );
    }
  }
  return res;
}
