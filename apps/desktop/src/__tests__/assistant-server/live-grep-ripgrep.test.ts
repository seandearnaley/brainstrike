import type { ChildProcess } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runRipgrep } from '../../assistant-server/live-grep-ripgrep';

const recorded = vi.hoisted(() => ({ args: [] as readonly string[], stdout: '' }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const execFile = (
    _file: string,
    args: readonly string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void
  ): ChildProcess => {
    recorded.args = args;
    const child = new actual.ChildProcess();
    queueMicrotask(() => {
      child.emit('exit', 0, null);
      callback(null, recorded.stdout, '');
    });
    return child;
  };
  return {
    ...actual,
    default: { ...actual, execFile },
    execFile,
  };
});

// Real Windows rg 15.2.0 path from PR #3543 receipt 6094014734. The live result
// retained './src/x.ts', duplicating indexed 'src/x.ts' at the same root and line.
const recordedWindowsPath = '.\\src\\x.ts';

describe('runRipgrep canonical candidate identity', () => {
  it.each([
    {
      filesOnly: false,
      format: 'JSON begin event',
      stdout: `${JSON.stringify({ data: { path: { text: recordedWindowsPath } }, type: 'begin' })}\n`,
    },
    { filesOnly: true, format: 'files-with-matches line', stdout: `${recordedWindowsPath}\r\n` },
  ])('normalizes the recorded Windows path in a $format', async ({ filesOnly, stdout }) => {
    recorded.stdout = stdout;

    const result = await runRipgrep({
      canonicalRootPath: path.resolve('recorded-workspace'),
      caseSensitive: true,
      filesOnly,
      prefilterLiteral: 'BST_M3_RG_MATCH',
      ripgrepPath: 'recorded-rg',
    });

    expect([...result.candidatePaths]).toEqual(['src/x.ts']);
    expect(result).toMatchObject({
      partialReadErrors: false,
      truncated: false,
    });
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
      prefilterLiteral: 'BST_M3_RG_MATCH',
      ripgrepPath: 'recorded-rg',
    });
    const flag = recorded.args.find((arg) => arg.startsWith('--ignore-file='));
    const file = flag?.slice('--ignore-file='.length) ?? '';
    const directory = path.dirname(file);
    expect(directory).not.toBe(os.tmpdir());
    expect(path.dirname(directory)).toBe(os.tmpdir());
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(readFileSync(file, 'utf8')).toContain('.env.*');
  });
});
