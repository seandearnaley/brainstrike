// M0-A1 item 2 (test/m0-kernel-sync.test.ts), opt-in: a short streaming run under a kernel tracer (darwin: syncspy via
// DYLD_INSERT_LIBRARIES; linux: strace + syncspy via LD_PRELOAD, counts cross-checked), attributed by attribute.mjs.
// Pins: >= 1 kernel sync inside every step-boundary span of every thread, 0 kernel syncs on the display path.
// Negative control: 'sqlite-auto' (SQLite's default autocheckpoint) puts checkpoint syncs inside a streaming COMMIT, and
// the attribution must see them.
//
// OPT-IN: set BRAINSTRIKE_STATE_STORE_KERNEL_SYNC=1. It needs the syncspy tracer, compiled here from syncspy.c (clang on
// macOS, cc + strace on Linux; Windows has no tracer). When opted in without a tracer, the suite is skipped and says why.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import { cleanupDirs, freshDir } from './helpers/fs.js';
import { PACKAGE_ROOT } from './helpers/proc.js';

const OPTED_IN = process.env['BRAINSTRIKE_STATE_STORE_KERNEL_SYNC'] === '1';
const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const SRC = here('./kernel-sync/syncspy.c');
const RUN = here('./kernel-sync/run.ts');
const ATTRIBUTE = here('./kernel-sync/attribute.mjs');
const has = (cmd: string, args: string[]): boolean =>
  spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;

function tracerOrReason(): { tracer: 'syncspy' | 'strace'; lib: string } | { reason: string } {
  if (process.platform === 'darwin') {
    if (!has('clang', ['--version'])) {
      return { reason: 'macOS without clang: syncspy.c cannot be compiled' };
    }
    return { lib: join(freshDir('spy'), 'syncspy.dylib'), tracer: 'syncspy' };
  }
  if (process.platform === 'linux') {
    if (!has('strace', ['-V'])) {
      return { reason: 'Linux without strace' };
    }
    if (!has('cc', ['--version'])) {
      return { reason: 'Linux without cc: syncspy.c cannot be compiled' };
    }
    return { lib: join(freshDir('spy'), 'syncspy.so'), tracer: 'strace' };
  }
  return {
    reason: `${process.platform} has no kernel-sync tracer (M0-A1: no strace or interposer on Windows)`,
  };
}

const setup = OPTED_IN
  ? tracerOrReason()
  : { reason: 'opt-in: set BRAINSTRIKE_STATE_STORE_KERNEL_SYNC=1' };
if (OPTED_IN && 'reason' in setup) {
  process.stderr.write(`\n[kernel-sync] OPTED IN BUT SKIPPED: ${setup.reason}\n\n`);
}
afterAll(() => cleanupDirs());

function traced(
  lib: string,
  tracer: 'syncspy' | 'strace',
  mode: string,
  args: string[]
): Record<string, never> & {
  boundaries: number;
  counts: { display: number; failed: number };
  ops: Record<string, number>;
  pass: { everyBoundaryHasKernelSync: boolean };
  straceCheck: { equal: boolean } | null;
} {
  const work = freshDir(`k-${mode}`);
  const raw = join(work, 'raw.json');
  const trace = join(work, 'spy.tsv');
  const strace = join(work, 'strace.txt');
  const nodeArgs = ['--import', 'tsx', RUN, mode, raw, ...args];
  if (tracer === 'syncspy') {
    execFileSync(process.execPath, nodeArgs, {
      cwd: PACKAGE_ROOT,
      env: { ...process.env, DYLD_INSERT_LIBRARIES: lib, M0_SYNCSPY_LOG: trace },
      stdio: 'pipe',
    });
  } else {
    execFileSync(
      'strace',
      [
        '-f',
        '-ttt',
        '-T',
        '-y',
        '--seccomp-bpf',
        '-e',
        'trace=fsync,fdatasync',
        '-o',
        strace,
        '-E',
        `LD_PRELOAD=${lib}`,
        '-E',
        `M0_SYNCSPY_LOG=${trace}`,
        process.execPath,
        ...nodeArgs,
      ],
      { cwd: PACKAGE_ROOT, stdio: 'pipe' }
    );
  }
  const out = execFileSync(
    process.execPath,
    [ATTRIBUTE, raw, trace, ...(tracer === 'strace' ? [strace] : [])],
    { encoding: 'utf8' }
  );
  const line = out.split('\n').find((l) => l.startsWith('M0ATTR ')) as string;
  const a = JSON.parse(line.slice(7));
  process.stdout.write(
    `[${mode}] ${JSON.stringify({ counts: a.counts, ops: a.ops, pass: a.pass, perThread: a.perThread, straceCheck: a.straceCheck })}\n`
  );
  return a;
}

describe.skipIf('reason' in setup)(
  `kernel syncs (${'reason' in setup ? `SKIPPED: ${setup.reason}` : setup.tracer})`,
  () => {
    const { lib, tracer } = setup as { tracer: 'syncspy' | 'strace'; lib: string };

    test('K-S: >= 1 kernel sync per step boundary per thread, 0 on the display path', () => {
      if (!existsSync(lib)) {
        execFileSync(
          tracer === 'syncspy' ? 'clang' : 'cc',
          tracer === 'syncspy'
            ? ['-O2', '-dynamiclib', '-o', lib, SRC]
            : ['-O2', '-shared', '-fPIC', '-o', lib, SRC, '-ldl']
        );
      }
      const a = traced(lib, tracer, 'boundary', ['2', '3', '200']);
      expect(a.boundaries).toBeGreaterThanOrEqual(8);
      expect(a.counts.display).toBe(0);
      expect(a.pass.everyBoundaryHasKernelSync).toBe(true);
      expect(a.counts.failed).toBe(0);
      if (a.straceCheck) {
        expect(a.straceCheck.equal).toBe(true);
      }
      expect(Object.keys(a.ops)).toEqual([tracer === 'syncspy' ? 'F_FULLFSYNC' : 'fsync']);
    }, 120_000);

    test('K-S-auto (negative control): the default autocheckpoint syncs inside a streaming COMMIT, and attribution sees it', () => {
      if (!existsSync(lib)) {
        execFileSync(
          tracer === 'syncspy' ? 'clang' : 'cc',
          tracer === 'syncspy'
            ? ['-O2', '-dynamiclib', '-o', lib, SRC]
            : ['-O2', '-shared', '-fPIC', '-o', lib, SRC, '-ldl']
        );
      }
      // 1500 deltas per step: the WAL must cross SQLite's 1000-page autocheckpoint during streaming on every machine (with
      // 500 a fast runner stayed under it for a whole run: M0-A1 CI run 36954577988, Linux).
      const a = traced(lib, tracer, 'sqlite-auto', ['3', '4', '1500']);
      expect(a.counts.display).toBeGreaterThan(0);
    }, 180_000);
  }
);
