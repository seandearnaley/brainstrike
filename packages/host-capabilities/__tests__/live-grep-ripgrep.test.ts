import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { runRipgrep } from '../src/native-tools/live-grep-ripgrep.js';

const recorded = vi.hoisted(() => ({ args: [] as readonly string[], stdout: '' }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const spawn = (_file: string, args: readonly string[]) => {
    recorded.args = args;
    const stdout = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      pid: undefined,
      signalCode: null,
      stdout,
    });
    queueMicrotask(() => {
      child.emit('spawn');
      stdout.end(recorded.stdout);
      stdout.once('end', () => {
        child.exitCode = 0;
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
      });
    });
    return child;
  };
  return { ...actual, default: { ...actual, spawn }, spawn };
});

// Real Windows rg 15.2.0 path from PR #3543 receipt 6094014734. The live result
// retained './src/x.ts', duplicating indexed 'src/x.ts' at the same root and line.
const recordedWindowsPath = '.\\src\\x.ts';

describe('runRipgrep canonical candidate identity', () => {
  it.each([
    {
      format: 'JSON begin event',
      mode: 'matches' as const,
      stdout: `${JSON.stringify({ data: { path: { text: recordedWindowsPath } }, type: 'begin' })}\n`,
    },
    {
      format: 'files-with-matches line',
      mode: 'files-with-matches' as const,
      stdout: `${recordedWindowsPath}\r\n`,
    },
  ])('normalizes the recorded Windows path in a $format', async ({ mode, stdout }) => {
    recorded.stdout = stdout;

    const result = await runRipgrep({
      canonicalRootPath: path.resolve('recorded-workspace'),
      caseSensitive: true,
      mode,
      prefilterLiteral: 'BST_M3_RG_MATCH',
      ripgrepPath: 'recorded-rg',
    });

    expect([...result.candidatePaths]).toEqual(['src/x.ts']);
    expect(result).toMatchObject({ partialReadErrors: false, truncated: false });
  });
});

// Codex review on #3718: a predictable name in the shared temp directory lets
// another local user plant a symlink there before the first grep, and a
// truncating write would follow it. The floor file lives in a directory only
// this process created and only its user can enter.
describe('runRipgrep credential floor file', () => {
  it('lives in an owner-only directory this process created, never at a shared predictable path', async () => {
    recorded.stdout = '';
    await runRipgrep({
      canonicalRootPath: path.resolve('recorded-workspace'),
      caseSensitive: true,
      mode: 'matches',
      prefilterLiteral: 'BST_M3_RG_MATCH',
      ripgrepPath: 'recorded-rg',
    });
    const flag = recorded.args.find((arg) => arg.startsWith('--ignore-file='));
    const file = flag?.slice('--ignore-file='.length) ?? '';
    const directory = path.dirname(file);
    expect(directory).not.toBe(os.tmpdir());
    expect(path.dirname(directory)).toBe(os.tmpdir());
    // Owner-only is what mkdtemp creates on this OS: 0o700 on POSIX. Windows has
    // no POSIX mode; there the per-user temp directory's ACL carries it.
    const reference = mkdtempSync(path.join(os.tmpdir(), 'bs-floor-mode-reference-'));
    try {
      expect(statSync(directory).mode & 0o777).toBe(statSync(reference).mode & 0o777);
    } finally {
      rmSync(reference, { force: true, recursive: true });
    }
    // Caseless, as the JS matcher reads the floor (Codex review on #3718).
    expect(readFileSync(file, 'utf8')).toContain('.[eE][nN][vV].*');
  });
});
