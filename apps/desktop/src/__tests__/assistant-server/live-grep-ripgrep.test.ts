import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runRipgrep } from '../../assistant-server/live-grep-ripgrep';

const recorded = vi.hoisted(() => ({ stdout: '' }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const execFile = (
    _file: string,
    _args: readonly string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void
  ): ChildProcess => {
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
