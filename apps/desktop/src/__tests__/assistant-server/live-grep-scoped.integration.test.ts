import { linkSync, mkdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeWorkspaceRoot } from '@brainstrike/agent';
import { createGrepLineMatcher } from '@brainstrike/db';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  probeExcludedPathMatches,
  resetRipgrepAvailabilityForTests,
  runLiveGrep,
  setMaxLiveCandidateFilesForTests,
} from '../../assistant-server/live-grep';
import { MAX_FILES_WALKED_PER_ROOT } from '../../assistant-server/workspace-file-walk';

const temporaryRoots: string[] = [];

async function workspace(): Promise<RuntimeWorkspaceRoot> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstrike-scoped-grep-'));
  temporaryRoots.push(directory);
  return { displayName: 'scoped', path: directory, rootId: 'scoped-root' };
}

async function write(root: RuntimeWorkspaceRoot, relative: string, content: string): Promise<void> {
  const absolute = path.join(root.path, relative);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content);
}

afterEach(async () => {
  vi.restoreAllMocks();
  resetRipgrepAvailabilityForTests();
  setMaxLiveCandidateFilesForTests();
  await Promise.all(
    temporaryRoots.splice(0).map((directory) => fs.rm(directory, { recursive: true }))
  );
});

describe('explicit-file live grep candidate scope', () => {
  let largeRoot: RuntimeWorkspaceRoot;
  beforeAll(async () => {
    largeRoot = await workspace();
    const root = largeRoot;
    await write(root, 'a-unrelated/seed.ts', 'value = 12345\n');
    await write(root, 'z-selected/keep.ts', 'selected = 98765\n');
    // Real directory entries beyond the walk ceiling; hard links keep fixture
    // storage small without faking candidate work or the authoritative reads.
    const seed = path.join(root.path, 'a-unrelated/seed.ts');
    for (let batch = 0; batch < MAX_FILES_WALKED_PER_ROOT / 500; batch += 1) {
      const directory = path.join(root.path, `a-unrelated/batch-${batch}`);
      mkdirSync(directory);
      for (let index = 0; index < 500; index += 1) {
        linkSync(seed, path.join(directory, `entry-${index}.ts`));
      }
    }
  });

  it('finds a selected file beyond the root visit cap without enumerating unrelated files', async () => {
    const root = largeRoot;
    // Stable traversal order makes the failure independent of filesystem order.
    const readdir = fs.readdir.bind(fs);
    const listing = vi.spyOn(fs, 'readdir').mockImplementation(async (...args) => {
      const entries = await readdir(...args);
      return entries.sort((left, right) => {
        const leftName =
          typeof left === 'object' && 'name' in left ? String(left.name) : String(left);
        const rightName =
          typeof right === 'object' && 'name' in right ? String(right.name) : String(right);
        return leftName.localeCompare(rightName);
      });
    });
    const startedAt = performance.now();
    const result = await runLiveGrep(
      {
        caseSensitive: false,
        contextLines: 0,
        filePaths: ['z-selected/keep.ts'],
        isRegex: true,
        pattern: '\\d{4,}',
        roots: [root],
      },
      createGrepLineMatcher('\\d{4,}', true, false)
    );
    process.stdout.write(
      `Scoped large-root search: ${(performance.now() - startedAt).toFixed(2)}ms; root listings: ${listing.mock.calls.length}\n`
    );
    expect(result.matches.map((match) => match.path)).toEqual(['z-selected/keep.ts']);
    expect(result.scanLimited).toBe(false);
    expect(result.truncated).toBe(false);
    expect(listing).not.toHaveBeenCalled();
  });

  it('does not discover or run ripgrep for a selected literal file or its excluded-path probe', async () => {
    const root = await workspace();
    await write(root, 'src/keep.ts', 'SCOPED_TOKEN\n');
    await write(root, 'node_modules/dep/index.ts', 'SCOPED_TOKEN\n');
    const stat = fs.stat.bind(fs);
    const discovery = vi.spyOn(fs, 'stat').mockImplementation(async (...args) => stat(...args));
    const options = {
      caseSensitive: false,
      contextLines: 0,
      filePaths: ['src/keep.ts'],
      isRegex: false,
      pattern: 'SCOPED_TOKEN',
      roots: [root],
    };
    const matcher = createGrepLineMatcher(options.pattern, false, false);
    const result = await runLiveGrep(options, matcher);
    expect(result.matches).toHaveLength(1);
    expect(result.engine).toBe('js-files');
    const probe = await probeExcludedPathMatches(
      { ...options, filePaths: ['node_modules/dep/index.ts'] },
      matcher
    );
    expect(probe.matchCount).toBe(1);
    const discovered = discovery.mock.calls.filter(
      ([target]) => typeof target === 'string' && /[/\\]rg(?:\.exe)?$/.test(target)
    );
    expect(discovered).toEqual([]);
  });

  it('keeps empty and missing scopes empty without a tree scan', async () => {
    const root = await workspace();
    await write(root, 'src/keep.ts', 'TOKEN\n');
    const listing = vi.spyOn(fs, 'readdir');
    for (const filePaths of [[], ['src/missing.ts'], ['src']]) {
      const result = await runLiveGrep(
        {
          caseSensitive: false,
          contextLines: 0,
          filePaths,
          isRegex: false,
          pattern: 'TOKEN',
          roots: [root],
        },
        createGrepLineMatcher('TOKEN', false, false)
      );
      expect(result).toMatchObject({
        engine: 'js-files',
        matches: [],
        scanLimited: false,
        truncated: false,
      });
    }
    expect(listing).not.toHaveBeenCalled();
  });

  it('keeps policy and hard ignores, file-symlink containment and directory no-follow rules', async () => {
    const root = await workspace();
    const outside = await workspace();
    await write(root, 'src/keep.ts', 'TOKEN\n');
    await write(root, 'src/secret.ts', 'TOKEN\n');
    await write(root, 'src/.llmignore', 'secret.ts\n');
    await write(root, 'dist/artifact.ts', 'TOKEN\n');
    await write(root, '.git/private.ts', 'TOKEN\n');
    await write(outside, 'escape.ts', 'TOKEN\n');
    await fs.symlink(path.join(root.path, 'src/keep.ts'), path.join(root.path, 'inside.ts'));
    await fs.symlink(path.join(root.path, 'src/secret.ts'), path.join(root.path, 'alias.ts'));
    await fs.symlink(path.join(root.path, '.git/private.ts'), path.join(root.path, 'git-alias.ts'));
    await fs.symlink(path.join(outside.path, 'escape.ts'), path.join(root.path, 'escape.ts'));
    await fs.symlink(path.join(root.path, 'src'), path.join(root.path, 'linked-dir'));
    const result = await runLiveGrep(
      {
        caseSensitive: false,
        contextLines: 0,
        filePaths: [
          'src/keep.ts',
          'src/secret.ts',
          'dist/artifact.ts',
          '.git/private.ts',
          'inside.ts',
          'alias.ts',
          'git-alias.ts',
          'escape.ts',
          'linked-dir/keep.ts',
        ],
        isRegex: false,
        pattern: 'TOKEN',
        roots: [root],
      },
      createGrepLineMatcher('TOKEN', false, false)
    );
    expect(result.matches.map((match) => match.path)).toEqual(['src/keep.ts', 'inside.ts']);
  });

  it('counts only eligible selected candidates and reports an actual scope overflow', async () => {
    const root = await workspace();
    await write(root, 'src/a.ts', 'TOKEN\n');
    await write(root, 'src/b.ts', 'TOKEN\n');
    await write(root, 'src/secret.ts', 'TOKEN\n');
    await write(root, '.llmignore', 'src/secret.ts\n');
    setMaxLiveCandidateFilesForTests(1);
    const options = {
      caseSensitive: false,
      contextLines: 0,
      isRegex: false,
      pattern: 'TOKEN',
      roots: [root],
    };
    const matcher = createGrepLineMatcher('TOKEN', false, false);
    const complete = await runLiveGrep(
      { ...options, filePaths: ['src/secret.ts', 'src/a.ts', 'missing.ts'] },
      matcher
    );
    expect(complete.matches.map((match) => match.path)).toEqual(['src/a.ts']);
    expect(complete.truncated).toBe(false);
    const capped = await runLiveGrep({ ...options, filePaths: ['src/a.ts', 'src/b.ts'] }, matcher);
    expect(capped.candidatesTruncated).toBe(true);
    expect(capped.note).toMatch(/candidate-file cap/);
  });

  it('refuses an unreadable selected file and retains other roots in the optional probe', async () => {
    const root = await workspace();
    await write(root, 'src/keep.ts', 'TOKEN\n');
    await write(root, 'node_modules/dep/index.ts', 'TOKEN\n');
    const canonicalKeep = await fs.realpath(path.join(root.path, 'src/keep.ts'));
    const stat = fs.stat.bind(fs);
    vi.spyOn(fs, 'stat').mockImplementation(async (...args) => {
      if (args[0] === canonicalKeep) {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      }
      return stat(...args);
    });
    const options = {
      caseSensitive: false,
      contextLines: 0,
      isRegex: false,
      pattern: 'TOKEN',
      roots: [root],
    };
    const matcher = createGrepLineMatcher('TOKEN', false, false);
    await expect(runLiveGrep({ ...options, filePaths: ['src/keep.ts'] }, matcher)).rejects.toThrow(
      'denied'
    );
    const probe = await probeExcludedPathMatches(
      {
        ...options,
        filePaths: ['node_modules/dep/index.ts'],
        roots: [{ ...root, path: `${root.path}/missing` }, root],
      },
      matcher
    );
    expect(probe.matchCount).toBe(1);
    const controller = new AbortController();
    controller.abort();
    expect(
      await probeExcludedPathMatches(
        { ...options, filePaths: ['node_modules/dep/index.ts'] },
        matcher,
        controller.signal
      )
    ).toEqual({ matchCount: 0 });
  });

  it('matches the approved canonical probe file when its requested symlink is retargeted', async () => {
    const root = await workspace();
    await write(root, 'src/keep.ts', 'TOKEN\n');
    await write(root, '.git/private.ts', 'TOKEN\nTOKEN\n');
    const alias = path.join(root.path, 'package-lock.json');
    await fs.symlink(path.join(root.path, 'src/keep.ts'), alias);
    const canonicalKeep = await fs.realpath(path.join(root.path, 'src/keep.ts'));
    const stat = fs.stat.bind(fs);
    let retargeted = false;
    vi.spyOn(fs, 'stat').mockImplementation(async (...args) => {
      const result = await stat(...args);
      if (args[0] === canonicalKeep && !retargeted) {
        retargeted = true;
        await fs.unlink(alias);
        await fs.symlink(path.join(root.path, '.git/private.ts'), alias);
      }
      return result;
    });
    const result = await probeExcludedPathMatches(
      {
        caseSensitive: false,
        filePaths: ['package-lock.json'],
        isRegex: false,
        pattern: 'TOKEN',
        roots: [root],
      },
      createGrepLineMatcher('TOKEN', false, false)
    );
    expect(retargeted).toBe(true);
    expect(result.matchCount).toBe(1);
  });
});
