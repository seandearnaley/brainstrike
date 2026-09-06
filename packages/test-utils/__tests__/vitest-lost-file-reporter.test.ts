// BST-1221: a worker killed mid-run (V8 fatal, OOM kill) leaves its test file
// with NO verdict. Vitest reports that file as `pending` and STILL calls the
// run `reason: 'passed'` — the exit code only turns non-zero via the separate
// unhandled-errors path, which `dangerouslyIgnoreUnhandledErrors` switches off.
// These tests pin the detection that makes a lost file fail on its own merits.
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs config-time module, no declaration file.
import { findLostTestFiles } from '../vitest-lost-file-reporter.mjs';

interface FakeModule {
  moduleId: string;
  state: () => string;
}

function mod(moduleId: string, state: string): FakeModule {
  return { moduleId, state: () => state };
}

describe('findLostTestFiles', () => {
  it('names a module left pending after a completed run', () => {
    const lost = findLostTestFiles(
      [mod('/a.test.ts', 'passed'), mod('/b.test.ts', 'pending')],
      'passed'
    );
    expect(lost).toEqual(['/b.test.ts']);
  });

  it('names a module left QUEUED — enqueued but never executed', () => {
    // vitest 4.1.10 has TWO non-verdict states. A pool killed before it picked
    // the module up leaves `queued`, which carries no verdict either; matching
    // only `pending` would let that file vanish silently.
    const lost = findLostTestFiles(
      [mod('/a.test.ts', 'passed'), mod('/b.test.ts', 'queued')],
      'passed'
    );
    expect(lost).toEqual(['/b.test.ts']);
  });

  it('fails CLOSED on an unrecognised state rather than assuming it is a pass', () => {
    // If a future vitest adds a state, the safe default is "lost": a loud,
    // fixable failure beats a silent green.
    const lost = findLostTestFiles([mod('/a.test.ts', 'some-future-state')], 'passed');
    expect(lost).toEqual(['/a.test.ts']);
  });

  it('reports nothing when every module reached a verdict', () => {
    const lost = findLostTestFiles(
      [mod('/a.test.ts', 'passed'), mod('/b.test.ts', 'failed'), mod('/c.test.ts', 'skipped')],
      'passed'
    );
    expect(lost).toEqual([]);
  });

  it('still reports a lost file when the run already failed for other reasons', () => {
    // A crash alongside a genuine failure must not be swallowed by the failure.
    const lost = findLostTestFiles(
      [mod('/a.test.ts', 'failed'), mod('/b.test.ts', 'pending')],
      'failed'
    );
    expect(lost).toEqual(['/b.test.ts']);
  });

  it('reports nothing when the user interrupted the run', () => {
    // Ctrl-C legitimately leaves modules unstarted; that is not a lost file.
    const lost = findLostTestFiles(
      [mod('/a.test.ts', 'passed'), mod('/b.test.ts', 'pending')],
      'interrupted'
    );
    expect(lost).toEqual([]);
  });

  it('names every lost module, not just the first', () => {
    const lost = findLostTestFiles(
      [mod('/a.test.ts', 'pending'), mod('/b.test.ts', 'passed'), mod('/c.test.ts', 'pending')],
      'passed'
    );
    expect(lost).toEqual(['/a.test.ts', '/c.test.ts']);
  });
});
