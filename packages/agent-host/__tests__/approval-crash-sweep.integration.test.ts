// ADR-0010, restart: once answered, an approved action runs at most once. If the host dies while
// it runs it is marked interrupted and never re-run; an approval answered just before a crash
// finishes at startup; a second answer is refused. The SIGKILL harness kills at a random moment
// and checks streamed chunks; this sweep kills after EVERY run-log commit of one approval round
// trip instead (exhaustive over k, not sampled), reopens the same root and lets recovery finish.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StateStore } from '@brainstrike/state-store';
import { expect, test } from 'vitest';
import { HostCore } from '../src/core.js';
import type { HostEvent, HostLogRow } from '../src/protocol.js';
import { approvalCrashPlatform, KILL_INSIDE_EFFECT } from './fixtures/approval-crash-platform.js';

const HOST = fileURLToPath(new URL('./fixtures/approval-crash-host.ts', import.meta.url));
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

interface HostExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
}

function runHost(root: string, effectFile: string, killAt: number): Promise<HostExit> {
  const child = spawn(process.execPath, [HOST, root, effectFile, String(killAt)], {
    cwd: PACKAGE_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code !== 0 && signal === null) {
        reject(new Error(`crash host exited ${code}: ${stderr}`));
        return;
      }
      resolve({ code, signal, stdout });
    });
  });
}

function effectLines(effectFile: string): number {
  return existsSync(effectFile)
    ? readFileSync(effectFile, 'utf8').split('\n').filter(Boolean).length
    : 0;
}

function eventsOf<Type extends HostEvent['type']>(
  rows: readonly HostLogRow[],
  type: Type
): Extract<HostEvent, { type: Type }>[] {
  return rows
    .map((row) => row.event)
    .filter((event): event is Extract<HostEvent, { type: Type }> => event.type === type);
}

/** What the killed process had durably committed when it died, read before recovery runs. */
interface CrashPoint {
  readonly answered: boolean;
  readonly effectFinished: boolean;
  readonly effectStarted: boolean;
  readonly requested: boolean;
  readonly runStarted: boolean;
}

async function verifyKill(k: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `bs-approval-crash-${k}-`));
  const root = join(dir, 'store');
  const effectFile = join(dir, 'effect.txt');
  try {
    const exit = await runHost(root, effectFile, k);
    if (process.platform !== 'win32') {
      expect(exit.signal, `k=${k}: the host was not killed at its commit`).toBe('SIGKILL');
    }
    expect(exit.stdout).not.toContain('COMMITS');
    const linesAtKill = effectLines(effectFile);
    expect(linesAtKill, `k=${k}`).toBeLessThanOrEqual(1);

    const store = await StateStore.open(root);
    let core: HostCore | undefined;
    try {
      expect(await store.check(), `k=${k}`).toEqual({ gaps: 0, integrity: 'ok' });
      // The crash point is what the store holds before Core recovers anything from it.
      const [threadId] = await store.threads();
      const committed = new Set(
        threadId === undefined ? [] : (await store.read(threadId)).map((row) => row.event.type)
      );
      const host = await HostCore.open(
        store,
        approvalCrashPlatform(effectFile),
        () => () => undefined
      );
      core = host;
      if (threadId === undefined) {
        expect(linesAtKill, `k=${k}`).toBe(0);
        return `k=${k}: nothing committed`;
      }
      const point: CrashPoint = {
        answered: committed.has('interaction.responded'),
        effectFinished: committed.has('effect.finished'),
        effectStarted: committed.has('effect.started'),
        requested: committed.has('interaction.requested'),
        runStarted: committed.has('run.started'),
      };
      // Recovery appends to the log but never removes the run or its request.
      const recovered = await host.read(threadId, 0);
      const [started] = eventsOf(recovered, 'run.started');
      if (!started) {
        expect(linesAtKill, `k=${k}`).toBe(0);
        return `k=${k}: thread only`;
      }
      const runId = started.runId;
      const [request] = eventsOf(recovered, 'interaction.requested');
      if (request && !point.answered) {
        // An unanswered top-level approval survives the restart and still takes its answer.
        expect(eventsOf(await host.read(threadId, 0), 'run.finished'), `k=${k}`).toEqual([]);
        await host.respond({
          commandId: `first-answer-after-crash-${k}`,
          decision: 'approve',
          interactionId: request.interactionId,
          runId,
          threadId,
        });
      }
      await expect
        .poll(async () => eventsOf(await host.read(threadId, 0), 'run.finished').length)
        .toBe(1);
      const rows = await host.read(threadId, 0);
      const [finished] = eventsOf(rows, 'run.finished');
      const lines = effectLines(effectFile);

      expect(eventsOf(rows, 'effect.started').length, `k=${k}`).toBeLessThanOrEqual(1);
      expect(lines, `k=${k}`).toBeLessThanOrEqual(1);
      if (k === KILL_INSIDE_EFFECT) {
        // Died after the tool wrote its line and before its finish committed.
        expect(point.effectStarted && !point.effectFinished, `k=${k}`).toBe(true);
        expect(linesAtKill, `k=${k}: the tool had not written its line`).toBe(1);
      }
      if (point.effectStarted) {
        // The effect's start was durable: recovery never runs it again.
        expect(lines, `k=${k}: an effect that had started ran again`).toBe(linesAtKill);
        expect(finished?.outcome, `k=${k}`).toBe(
          point.effectFinished ? 'completed' : 'interrupted'
        );
      } else if (point.requested) {
        // Answered before the crash (finished at startup) or answered after it: it ran once.
        expect(lines, `k=${k}: an approved action did not run exactly once`).toBe(1);
        expect(finished?.outcome, `k=${k}`).toBe('completed');
      } else {
        // Died outside a committed decision boundary: nothing ran and nothing will.
        expect(lines, `k=${k}`).toBe(0);
        expect(finished?.outcome, `k=${k}`).toBe('interrupted');
      }

      if (request) {
        await expect(
          host.respond({
            commandId: `second-answer-after-crash-${k}`,
            decision: 'approve',
            interactionId: request.interactionId,
            runId,
            threadId,
          }),
          `k=${k}: a second answer was accepted`
        ).rejects.toThrow();
        expect(effectLines(effectFile), `k=${k}`).toBe(lines);
      }
      expect(await store.check(), `k=${k}`).toEqual({ gaps: 0, integrity: 'ok' });
      const reached = Object.entries(point)
        .filter(([, value]) => value)
        .map(([key]) => key)
        .join(',');
      return `k=${k}: [${reached}] -> ${finished?.outcome} lines=${lines}`;
    } finally {
      await core?.close();
      await store.close();
    }
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

test('SIGKILL after every commit of an approval round trip: the approved action runs at most once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bs-approval-crash-count-'));
  let commits: number;
  try {
    const clean = await runHost(join(dir, 'store'), join(dir, 'effect.txt'), -1);
    const [, count, outcome] = clean.stdout.match(/^COMMITS (\d+) (\S+)$/mu) ?? [];
    expect(outcome).toBe('completed');
    expect(effectLines(join(dir, 'effect.txt'))).toBe(1);
    commits = Number(count);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
  expect(commits).toBeGreaterThan(0);
  // Every kill point owns its data root, so the points run side by side.
  const points = [...Array.from({ length: commits + 1 }, (_, k) => k), KILL_INSIDE_EFFECT];
  const reports = await Promise.all(points.map((k) => verifyKill(k)));
  process.stdout.write(`[approval crash sweep] N=${commits}\n${reports.join('\n')}\n`);
}, 120_000);
