// M0-A1 item 5, the process-crash contract (scripts/m0/kill-driver.mjs): TRIALS x { recorder up -> host streams (root +
// 3 children, 4 steps each, 500 unique token deltas per step) -> SIGKILL at U[0, 2000] ms after the first shown chunk
// (Windows: TerminateProcess) -> the recorder drains and fsyncs -> a fresh verifier reopens the SAME store and checks }.
// One store is reused for every trial, so it is crash-recovered TRIALS times. Pass: 0 shown chunks lost or mismatched,
// integrity_check ok and no seq gap on every reopen. 20 kills per run; STATE_STORE_KILL_TRIALS raises it (nightly: 100).
import { loadavg } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, test } from 'vitest';
import { cleanupDirs, freshDir } from './helpers/fs.js';
import { killKids, run, runTs } from './helpers/proc.js';

const TRIALS = Number(process.env['STATE_STORE_KILL_TRIALS'] ?? '20');
const KILL_MAX_MS = 2000;
const HOST = fileURLToPath(new URL('./kill/kill-host.ts', import.meta.url));
const VERIFY = fileURLToPath(new URL('./kill/kill-verify.ts', import.meta.url));
const RECORDER = fileURLToPath(new URL('./kill/recorder.mjs', import.meta.url));

afterAll(() => {
  killKids();
  cleanupDirs();
});

interface Verify {
  readonly brokeStale: number;
  readonly check: {
    shown: number;
    lost: number;
    mismatched: number;
    committedNotShown: unknown;
    firstProblem?: string;
  };
  readonly openError?: string;
  readonly openMs: number;
  readonly rows: number;
  readonly threads: number;
  readonly trial: string;
  readonly validity: { integrity: string; gaps: number };
}

test(
  `SIGKILL x ${TRIALS} mid-stream: 0 shown chunks lost, every reopen valid`,
  async () => {
    expect(Number.isInteger(TRIALS) && TRIALS > 0).toBe(true);
    const dir = freshDir('kill');
    const root = join(dir, 'store');
    const results: Array<
      Verify & {
        killAfterFirstShownMs: number;
        finishedBeforeKill: boolean;
        hostSignal: string | null;
      }
    > = [];
    for (let i = 0; i < TRIALS; i++) {
      const sock =
        process.platform === 'win32'
          ? `\\\\.\\pipe\\bs-ss-kill-${process.pid}-${i}`
          : join(dir, `r${i}.sock`);
      const recFile = join(dir, `rec-${i}.jsonl`);
      const recorder = run([RECORDER, sock, recFile]);
      await recorder.line('LISTENING', 10_000);
      const host = runTs(HOST, [root, sock, String(i)]);
      await host.line('STREAMING', 90_000);
      const delay = Math.random() * KILL_MAX_MS;
      await new Promise((r) => {
        setTimeout(r, delay);
      });
      const finishedBeforeKill = host.out().includes('DONE');
      host.p.kill('SIGKILL');
      await host.exit();
      await recorder.exit();
      const v = runTs(VERIFY, [root, recFile, String(i)]);
      const line = await v.line('M0VERIFY', 90_000);
      await v.exit();
      const verify = JSON.parse(line.slice('M0VERIFY '.length)) as Verify;
      const t = {
        ...verify,
        finishedBeforeKill,
        hostSignal: host.p.signalCode,
        killAfterFirstShownMs: Number(delay.toFixed(1)),
      };
      results.push(t);
      process.stdout.write(
        `[kill #${i}] kill@${t.killAfterFirstShownMs}ms load=${loadavg()[0]?.toFixed(2)} ${verify.openError ? `OPEN ERROR ${verify.openError.split('\n')[0]}` : `shown=${verify.check.shown} lost=${verify.check.lost} mismatched=${verify.check.mismatched} committedNotShown=${JSON.stringify(verify.check.committedNotShown)} integrity=${verify.validity.integrity} gaps=${verify.validity.gaps} brokeStale=${verify.brokeStale} open=${verify.openMs}ms ${verify.check.firstProblem ?? ''}`}\n`
      );
    }
    const shown = results.reduce((n, r) => n + (r.check?.shown ?? 0), 0);
    const lost = results.reduce((n, r) => n + (r.check?.lost ?? 0), 0);
    process.stdout.write(`[kill summary] trials=${TRIALS} shown=${shown} lost=${lost}\n`);
    for (const r of results) {
      expect(r.openError, `trial ${r.trial}`).toBeUndefined();
      expect(
        r.finishedBeforeKill,
        `trial ${r.trial} finished before the kill: it proves nothing`
      ).toBe(false);
      if (process.platform !== 'win32') {
        expect(r.hostSignal).toBe('SIGKILL');
      }
      expect(r.brokeStale, `trial ${r.trial}: the dead host's lock was recovered`).toBe(1);
      expect(r.validity).toEqual({ gaps: 0, integrity: 'ok' });
      expect(r.check.shown).toBeGreaterThan(0);
      expect(r.check.lost, `trial ${r.trial}: ${r.check.firstProblem ?? ''}`).toBe(0);
      expect(r.check.mismatched, `trial ${r.trial}: ${r.check.firstProblem ?? ''}`).toBe(0);
    }
  },
  TRIALS * 60_000
);
