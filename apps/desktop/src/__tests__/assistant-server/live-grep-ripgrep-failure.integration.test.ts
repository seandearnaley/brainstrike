/**
 * BST-1246 coverage for the live-grep ripgrep failure paths: exit-2-with-stdout
 * keeps its candidates (partial read errors), genuine failures log non-sensitive
 * metadata, and the normal pass prunes every policy-unconditional directory
 * while the excluded-path probe keeps searching them. Split from
 * `live-grep.integration.test.ts` alongside the `live-grep-ripgrep.ts` module
 * split (both files were at the 1000-line lint ceiling).
 */
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeWorkspaceRoot } from '@brainstrike/agent';
import { createGrepLineMatcher } from '@brainstrike/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  probeExcludedPathMatches,
  resetRipgrepAvailabilityForTests,
  runLiveGrep,
} from '../../assistant-server/live-grep';

const { loggerWarnMock } = vi.hoisted(() => ({
  loggerWarnMock: vi.fn(),
}));

vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: loggerWarnMock,
    }),
  };
});

const createdRoots: string[] = [];
const originalPath = process.env['PATH'];

async function makeWorkspace(files: Record<string, string>): Promise<string> {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-livegrep-1246-'));
  createdRoots.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await fsPromises.mkdir(path.dirname(absolute), { recursive: true });
    await fsPromises.writeFile(absolute, content, 'utf8');
  }
  return root;
}

function root(rootPath: string, id = 'root-1', name = 'workspace'): RuntimeWorkspaceRoot {
  return { displayName: name, path: rootPath, rootId: id };
}

function literalMatcher(pattern: string): ReturnType<typeof createGrepLineMatcher> {
  return createGrepLineMatcher(pattern, false, false);
}

/** Put a fake `rg` shell script on PATH for the duration of `fn`. */
async function withFakeRipgrep<T>(script: string, fn: (binDir: string) => Promise<T>): Promise<T> {
  const binDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-rg-fake-'));
  createdRoots.push(binDir);
  const rgPath = path.join(binDir, 'rg');
  await fsPromises.writeFile(rgPath, script, { mode: 0o755 });
  await fsPromises.chmod(rgPath, 0o755);
  process.env['PATH'] = binDir;
  resetRipgrepAvailabilityForTests();
  try {
    return await fn(binDir);
  } finally {
    process.env['PATH'] = originalPath;
    resetRipgrepAvailabilityForTests();
  }
}

beforeEach(() => {
  resetRipgrepAvailabilityForTests();
  loggerWarnMock.mockReset();
});

afterEach(async () => {
  resetRipgrepAvailabilityForTests();
  process.env['PATH'] = originalPath;
  while (createdRoots.length > 0) {
    const dir = createdRoots.pop();
    if (dir) {
      await fsPromises.rm(dir, { force: true, recursive: true });
    }
  }
});

describe('runLiveGrep — BST-1246 ripgrep failure handling', () => {
  it('keeps rg candidates on exit 2 with usable stdout instead of degrading to the walk', async () => {
    if (process.platform === 'win32') {
      return;
    }
    const workspace = await makeWorkspace({ 'a.ts': 'const needle = 1;\n' });
    // One valid --json begin event, then rg's "some files errored" exit code.
    const beginEvent = JSON.stringify({ data: { path: { text: 'a.ts' } }, type: 'begin' });

    const result = await withFakeRipgrep(`#!/bin/sh\necho '${beginEvent}'\nexit 2\n`, async () =>
      runLiveGrep(
        {
          caseSensitive: false,
          contextLines: 0,
          isRegex: false,
          pattern: 'needle',
          roots: [root(workspace)],
        },
        literalMatcher('needle')
      )
    );

    expect(result.engine).toBe('ripgrep');
    expect(result.matches.map((match) => match.path)).toEqual(['a.ts']);
    expect(result.note).toMatch(/unreadable/i);
    expect(loggerWarnMock).not.toHaveBeenCalledWith(
      'live grep: ripgrep failed; falling back to JS file-walk',
      expect.anything()
    );
  });

  it('degrades to the walk when rg is signal-terminated, instead of a clean zero-match', async () => {
    if (process.platform === 'win32') {
      return;
    }
    const workspace = await makeWorkspace({ 'a.ts': 'const needle = 1;\n' });

    // Externally killed rg (OOM killer / supervisor): execFile reports
    // code null + a signal + killed false, which used to slip past both
    // rejection branches and resolve as a SUCCESSFUL empty search.
    const result = await withFakeRipgrep('#!/bin/sh\nkill -9 $$\n', async () =>
      runLiveGrep(
        {
          caseSensitive: false,
          contextLines: 0,
          isRegex: false,
          pattern: 'needle',
          roots: [root(workspace)],
        },
        literalMatcher('needle')
      )
    );

    expect(result.engine).toBe('js-walk');
    expect(result.matches.map((match) => match.path)).toEqual(['a.ts']);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      'live grep: ripgrep failed; falling back to JS file-walk',
      expect.objectContaining({
        ripgrep: expect.objectContaining({ signal: 'SIGKILL', timedOut: false }),
      })
    );
  });

  it('logs non-sensitive failure metadata when rg genuinely fails (exit 2, empty stdout)', async () => {
    if (process.platform === 'win32') {
      return;
    }
    const workspace = await makeWorkspace({ 'a.ts': 'needle here\n' });

    await withFakeRipgrep('#!/bin/sh\nexit 2\n', async () => {
      await runLiveGrep(
        {
          caseSensitive: false,
          contextLines: 0,
          isRegex: false,
          pattern: 'needle',
          roots: [root(workspace)],
        },
        literalMatcher('needle')
      );
    });

    expect(loggerWarnMock).toHaveBeenCalledWith(
      'live grep: ripgrep failed; falling back to JS file-walk',
      expect.objectContaining({
        ripgrep: expect.objectContaining({
          exitCode: 2,
          killed: false,
          timedOut: false,
        }),
      })
    );
  });

  it('prunes every policy-unconditional directory in the normal pass but not in the probe', async () => {
    if (process.platform === 'win32') {
      return;
    }
    const workspace = await makeWorkspace({ 'a.ts': 'needle here\n' });
    const recordArgsScript = (argsFile: string) =>
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\nexit 1\n`;

    const argsDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-rg-argv-'));
    createdRoots.push(argsDir);
    const liveArgsFile = path.join(argsDir, 'live.txt');
    await withFakeRipgrep(recordArgsScript(liveArgsFile), async () => {
      await runLiveGrep(
        {
          caseSensitive: false,
          contextLines: 0,
          isRegex: false,
          pattern: 'needle',
          roots: [root(workspace)],
        },
        literalMatcher('needle')
      );
    });
    const livePassArgs = await fsPromises.readFile(liveArgsFile, 'utf8');

    // The 4s rg timeout was blown on real repos because only .git/node_modules
    // were pruned — .vite/dist/.turbo/coverage artifact trees were scanned in
    // full. Prune exactly the balanced policy's unconditional by-name
    // exclusions (resolveCandidate re-applies the same policy, so the rg
    // candidate set stays a strict superset of policy-kept files).
    for (const segment of ['.git', 'node_modules', '.vite', 'dist', '.turbo', 'coverage']) {
      expect(livePassArgs).toContain(`--glob=!**/${segment}/`);
    }
    expect(livePassArgs).toContain('--glob=!.claude/worktrees/**');
    expect(livePassArgs).toContain('--glob=!.brainstrike/worktrees/**');

    const probeArgsFile = path.join(argsDir, 'probe.txt');
    await withFakeRipgrep(recordArgsScript(probeArgsFile), async () => {
      await probeExcludedPathMatches(
        {
          caseSensitive: false,
          isRegex: false,
          pattern: 'needle',
          roots: [root(workspace)],
        },
        literalMatcher('needle')
      );
    });
    const probeArgs = await fsPromises.readFile(probeArgsFile, 'utf8');

    // The probe's PURPOSE is to find matches inside policy-excluded paths —
    // it must keep searching them (only .git stays hard-pruned).
    expect(probeArgs).toContain('--glob=!**/.git/');
    expect(probeArgs).not.toContain('--glob=!**/node_modules/');
    expect(probeArgs).not.toContain('--glob=!**/dist/');
  });
});
