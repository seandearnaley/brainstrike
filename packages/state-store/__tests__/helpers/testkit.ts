// Test instruments (M0-A2 src/testkit.ts): byte search of a whole root, lsof of processes, deterministic content, and the
// spike's two event shapes (text, tool-result) for the purge, export and schema suites.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { AppendItem } from '../../src/run-log-types.js';
import { largeText, type StateStore } from '../../src/state-store.js';

export const SECRET = 'SECRET-7f3a';

/** Occurrences of `needle` in every file under `root` (all bytes: WAL, SHM, freelist pages, temp files, lock files). */
export function byteSearch(
  root: string,
  needle: string | Buffer
): { total: number; files: Record<string, number> } {
  const n = typeof needle === 'string' ? Buffer.from(needle, 'utf8') : needle;
  const files: Record<string, number> = {};
  let total = 0;
  const walk = (dir: string): void => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, d.name);
      if (d.isDirectory()) {
        walk(p);
        continue;
      }
      const b = readFileSync(p);
      let c = 0;
      for (let i = b.indexOf(n); i >= 0; i = b.indexOf(n, i + 1)) {
        c++;
      }
      if (c > 0) {
        files[relative(root, p)] = c;
        total += c;
      }
    }
  };
  walk(root);
  return { files, total };
}

export interface OpenFile {
  fd: string;
  inode: number | null;
  mode: string;
  name: string;
  pid: number;
}

/** lsof exists on macOS and Linux only; the suites that need it say so when it is absent. */
export const HAS_LSOF = process.platform !== 'win32';

/** Files `pids` hold open whose path is under `root` (lsof -F). */
export function lsofUnder(pids: readonly number[], root: string): OpenFile[] {
  const real = realpathSync(root);
  let out = '';
  try {
    out = execFileSync('lsof', ['-nP', '-w', '-p', pids.join(','), '-F', 'pfani'], {
      encoding: 'utf8',
      maxBuffer: 64 << 20,
    });
  } catch (e) {
    // lsof exits 1 when none of the pids has any file it can list; any other failure must surface.
    const err = e as { status?: number; stdout?: string };
    if (err.status !== 1) {
      throw e;
    }
    out = err.stdout ?? '';
  }
  const res: OpenFile[] = [];
  let pid = -1;
  let cur: Partial<OpenFile> = {};
  for (const line of out.split('\n')) {
    const k = line[0];
    const v = line.slice(1);
    if (k === 'p') {
      pid = Number(v);
    } else if (k === 'f') {
      cur = { fd: v, inode: null, mode: '', pid };
    } else if (k === 'a') {
      cur.mode = v;
    } else if (k === 'i') {
      cur.inode = Number(v);
    } else if (k === 'n') {
      cur.name = v;
      if (v === real || v.startsWith(`${real}/`)) {
        res.push(cur as OpenFile);
      }
    }
  }
  return res;
}

export const inodeOf = (p: string): number => statSync(p).ino;

/** Seeded PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d_2b_79_f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const SYL = [
  'ka',
  'lo',
  'mi',
  'ne',
  'ru',
  'sa',
  'ti',
  'vo',
  'ze',
  'pa',
  'qu',
  'do',
  'fi',
  'gu',
  'he',
  'jo',
];

/** Prose from a ~4k-word vocabulary; never contains digits or '-', so it cannot collide with the secret. */
export function prose(r: () => number, bytes: number): string {
  const words: string[] = [];
  let len = 0;
  while (len < bytes) {
    const n = 1 + Math.floor(r() * 3);
    let w = '';
    for (let i = 0; i < n; i++) {
      w += SYL[Math.floor(r() * SYL.length)];
    }
    words.push(w);
    len += w.length + 1;
  }
  return words.join(' ').slice(0, bytes);
}

/** The spike's two event inputs (M0-A2 src/host.ts Input). */
export type Input = { type: 'text'; content: string } | { type: 'tool-result'; output: string };

/** `n` events; event `k` is a >= 12 KB tool output whose inline preview and blob both contain the secret. */
export function seedInputs(n: number, k: number, seed = 1, textBytes = 400): Input[] {
  const r = rng(seed);
  return Array.from(
    { length: n },
    (_, i): Input =>
      i + 1 === k
        ? { output: `${prose(r, 300)} ${SECRET} ${prose(r, 16 * 1024)}`, type: 'tool-result' }
        : { content: prose(r, textBytes), type: 'text' }
  );
}

/** M0-A2 Host.toBody: a text event, or a tool result whose output becomes a blob at 12 KB or more. */
export function toItem(threadId: string, i: Input): AppendItem {
  if (i.type === 'text') {
    return { event: { content: i.content, type: 'text', v: 2 }, threadId };
  }
  const { blob, fields } = largeText(i.output);
  const event = { type: 'tool-result', v: 2, ...fields };
  return blob ? { blobs: [blob], event, threadId } : { event, threadId };
}

/** M0-A2 Host.append(thread, inputs): seqs assigned. */
export async function appendInputs(
  store: StateStore,
  threadId: string,
  inputs: readonly Input[]
): Promise<number[]> {
  return (await store.append(inputs.map((i) => toItem(threadId, i)))).map((r) => r.seq);
}

export const textBody = (content: string): string =>
  JSON.stringify({ content, type: 'text', v: 2 });
