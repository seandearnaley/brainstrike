/**
 * BST-1939: `brainstrike threads search` refuses invalid input with one plain
 * line per problem, before it attaches to or starts any host.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

/** The real CLI process: its stderr and exit code. */
async function cli(dataRoot: string, args: string[]): Promise<{ code: number; stderr: string }> {
  try {
    await promisify(execFile)(
      process.execPath,
      [cliPath, '--data-root', dataRoot, 'threads', 'search', ...args],
      { windowsHide: true }
    );
    return { code: 0, stderr: '' };
  } catch (error) {
    const failed = error as { code?: number; stderr?: string };
    return { code: failed.code ?? -1, stderr: failed.stderr ?? '' };
  }
}

test.each([
  // Smoke of #3568: a whitespace-only query printed a zod issue array.
  [['--query', '   '], 'Missing --query'],
  // `--limit -3` is refused by node:util parseArgs as an ambiguous option
  // before this command reads it; the `=` form reaches the plain check.
  [['--query', 'smoke', '--limit=-3'], '--limit must be an integer from 1 to 100'],
  [['--query', 'smoke', '--limit', 'abc'], '--limit must be an integer from 1 to 100'],
  [['--query', 'smoke', '--limit', '0'], '--limit must be an integer from 1 to 100'],
  [['--query', 'smoke', '--limit', '101'], '--limit must be an integer from 1 to 100'],
  [['--query', 'smoke', '--limit', '2.5'], '--limit must be an integer from 1 to 100'],
  [
    ['--query', 'smoke', '--since', '2026-10-02', '--until', '2026-10-01'],
    '--since must not be after --until',
  ],
  [['--query', 'x'.repeat(501)], '--query must be at most 500 characters'],
  [
    ['--query', 'smoke', '--limit', '0', '--since', 'yesterday'],
    '--limit must be an integer from 1 to 100\n--since must be an ISO 8601 date or date-time',
  ],
])('threads search %j prints its problems and exits 1', async (args, message) => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'bs-m6-cli-search-'));
  try {
    expect(await cli(dataRoot, args)).toEqual({ code: 1, stderr: `${message}\n` });
    // Refused before any host lease, socket or log was created.
    expect(await readdir(dataRoot)).toEqual([]);
  } finally {
    await rm(dataRoot, { force: true, recursive: true });
  }
});
