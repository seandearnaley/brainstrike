/**
 * Unit coverage for the desktop LIVE grep pass (`runLiveGrep`). Exercises the
 * real on-disk discovery (ripgrep + JS-walk fallback), the shared JS matcher,
 * the ignore policy, multi-root scoping, and the symlink-containment discipline
 * against temp-dir workspaces — no DB, no agent loop.
 */
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeWorkspaceRoot } from '@brainstrike/agent';
import { createGrepLineMatcher } from '@brainstrike/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  discoverRipgrepPathForTests,
  resetRipgrepAvailabilityForTests,
  runLiveGrep,
  setMaxLiveCandidateFilesForTests,
} from '../../assistant-server/live-grep';

const { loggerWarnMock } = vi.hoisted(() => ({
  loggerWarnMock: vi.fn(),
}));

vi.mock('@brainstrike/utils/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/utils/logger')>();
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

async function makeWorkspace(
  files: Record<string, string>,
  prefix = 'brainstrike-livegrep-'
): Promise<string> {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), prefix));
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

function regexMatcher(pattern: string): ReturnType<typeof createGrepLineMatcher> {
  return createGrepLineMatcher(pattern, true, false);
}

const originalPath = process.env['PATH'];

beforeEach(() => {
  resetRipgrepAvailabilityForTests();
  loggerWarnMock.mockReset();
});

afterEach(async () => {
  resetRipgrepAvailabilityForTests();
  setMaxLiveCandidateFilesForTests();
  process.env['PATH'] = originalPath;
  while (createdRoots.length > 0) {
    const dir = createdRoots.pop();
    if (dir) {
      await fsPromises.rm(dir, { force: true, recursive: true });
    }
  }
});

/** Absolute path to the real `rg` binary if it is on PATH (else null), for the PATH-discovery test. */
async function findRealRipgrep(): Promise<string | null> {
  for (const dir of (originalPath ?? '').split(path.delimiter)) {
    if (dir.length === 0) {
      continue;
    }
    const candidate = path.join(dir, 'rg');
    try {
      const stat = await fsPromises.stat(candidate);
      if (stat.isFile()) {
        return candidate;
      }
    } catch {
      // not here; keep looking
    }
  }
  return null;
}

/**
 * Run `fn` with ripgrep forced UNAVAILABLE: an empty PATH bin dir plus a stat
 * shim that misses every `.../rg(.exe)` probe (PATH and the hardcoded fallback
 * dirs alike), so `runLiveGrep` takes the JS-walk path. Restores PATH + the stat
 * spy afterwards. Lets a test compare the js-walk candidate set against the rg
 * one on the SAME workspace (the rg-vs-walk parity assertion).
 */
async function withRipgrepHidden<T>(fn: () => Promise<T>): Promise<T> {
  const binDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-livegrep-hide-'));
  createdRoots.push(binDir);
  process.env['PATH'] = binDir;
  const realStat = fsPromises.stat.bind(fsPromises);
  const statSpy = vi
    .spyOn(fsPromises, 'stat')
    .mockImplementation(async (target: Parameters<typeof realStat>[0]) => {
      if (typeof target === 'string' && (target.endsWith('/rg') || target.endsWith('\\rg.exe'))) {
        throw new Error('ENOENT: ripgrep hidden for test');
      }
      return realStat(target);
    });
  resetRipgrepAvailabilityForTests();
  try {
    return await fn();
  } finally {
    statSpy.mockRestore();
    process.env['PATH'] = originalPath;
    resetRipgrepAvailabilityForTests();
  }
}

/**
 * Run `fn` with a fake `rg` on PATH that always exits 2 (rg's "genuine error"
 * code), forcing `runLiveGrep` down the execFile-rejection branch. Node's
 * execFile error embeds the full spawned command line (including the pattern)
 * in `.message`/`.cmd` — this is the exact leak surface the redaction below
 * regression-tests. Restores PATH afterwards.
 */
async function withRipgrepFailing<T>(fn: () => Promise<T>): Promise<T> {
  const binDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-livegrep-fail-'));
  createdRoots.push(binDir);
  const rgPath = path.join(binDir, 'rg');
  await fsPromises.writeFile(rgPath, '#!/bin/sh\nexit 2\n', { mode: 0o755 });
  await fsPromises.chmod(rgPath, 0o755);
  process.env['PATH'] = binDir;
  resetRipgrepAvailabilityForTests();
  try {
    return await fn();
  } finally {
    process.env['PATH'] = originalPath;
    resetRipgrepAvailabilityForTests();
  }
}

/**
 * Run `fn` with a fake `rg` that reports the documented clean "no matches"
 * exit code. This pins exit 1 as a successful ripgrep pass rather than a
 * failure that silently switches engines.
 */
async function withRipgrepReturningNoMatches<T>(fn: () => Promise<T>): Promise<T> {
  const binDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-livegrep-empty-'));
  createdRoots.push(binDir);
  const rgPath = path.join(binDir, 'rg');
  await fsPromises.writeFile(rgPath, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  await fsPromises.chmod(rgPath, 0o755);
  process.env['PATH'] = binDir;
  resetRipgrepAvailabilityForTests();
  try {
    return await fn();
  } finally {
    process.env['PATH'] = originalPath;
    resetRipgrepAvailabilityForTests();
  }
}

describe('runLiveGrep — failure-path log redaction (regression for PR #1337 gap)', () => {
  it('redacts the workspace root path when a root is not accessible', async () => {
    const secretPath = path.join(os.tmpdir(), 'brainstrike-secret-workspace-root-does-not-exist');

    await runLiveGrep(
      {
        caseSensitive: false,
        contextLines: 0,
        isRegex: false,
        pattern: 'x',
        roots: [root(secretPath)],
      },
      literalMatcher('x')
    );

    expect(loggerWarnMock).toHaveBeenCalledWith(
      'live grep: root is not accessible',
      expect.objectContaining({
        error: expect.objectContaining({ redacted: true }),
        rootId: 'root-1',
      })
    );
    expect(JSON.stringify(loggerWarnMock.mock.calls)).not.toContain(secretPath);
  });

  it('redacts the grep pattern when ripgrep fails and falls back to the JS walk', async () => {
    if (process.platform === 'win32') {
      // The fake `rg` above is a POSIX shell script; skip on Windows.
      return;
    }
    const workspace = await makeWorkspace({ 'a.ts': 'needle here' });
    const secretPattern = 'OPENAI_API_KEY_sk_sensitive_test_marker';

    await withRipgrepFailing(async () => {
      await runLiveGrep(
        {
          caseSensitive: false,
          contextLines: 0,
          isRegex: false,
          pattern: secretPattern,
          roots: [root(workspace)],
        },
        literalMatcher(secretPattern)
      );
    });

    expect(loggerWarnMock).toHaveBeenCalledWith(
      'live grep: ripgrep failed; falling back to JS file-walk',
      expect.objectContaining({ error: expect.objectContaining({ redacted: true }) })
    );
    expect(JSON.stringify(loggerWarnMock.mock.calls)).not.toContain(secretPattern);
  });
});

describe('runLiveGrep — basics', () => {
  it('skips (engine: skipped) when no roots are supplied', async () => {
    const result = await runLiveGrep(
      {
        caseSensitive: false,
        contextLines: 0,
        isRegex: false,
        pattern: 'x',
        roots: [],
      },
      literalMatcher('x')
    );
    expect(result.engine).toBe('skipped');
    expect(result.matches).toEqual([]);
  });

  it('finds on-disk matches with a live engine and labels their root', async () => {
    const dir = await makeWorkspace({
      'src/a.ts': 'alpha\nLIVE_MARKER here\nbeta\n',
      'src/b.ts': 'no match here\n',
    });
    const result = await runLiveGrep(
      {
        caseSensitive: false,
        contextLines: 1,
        isRegex: false,
        pattern: 'LIVE_MARKER',
        roots: [root(dir, 'id-a', 'alpha-root')],
      },
      literalMatcher('LIVE_MARKER')
    );
    // The live pass RAN on disk (not 'skipped'). Which engine resolved the
    // candidates — ripgrep when `rg` is installed, the JS walk otherwise — is an
    // environment detail (CI runners lack rg), and both produce identical matches
    // by design. The rg-specific and js-walk-specific paths are pinned in their
    // own dedicated tests; here we only assert liveness.
    expect(result.engine).not.toBe('skipped');
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.path).toBe('src/a.ts');
    expect(result.matches[0]?.line).toBe(2);
    expect(result.matches[0]?.before).toEqual(['alpha']);
    expect(result.matches[0]?.after).toEqual(['beta']);
    expect(result.matches[0]?.rootId).toBe('id-a');
    expect(result.matches[0]?.rootName).toBe('alpha-root');
    // The clean ripgrep path emits no note; the js-walk fallback (rg absent, as
    // on CI) emits the non-silent degradation note. Tie the expectation to the
    // engine that actually ran rather than the host's rg availability.
    if (result.engine === 'ripgrep') {
      expect(result.note).toBeUndefined();
    } else {
      expect(result.note).toMatch(/ripgrep is unavailable/i);
    }
  });

  it('treats ripgrep exit code 1 as a clean no-match result without fallback', async () => {
    if (process.platform === 'win32') {
      return;
    }
    const dir = await makeWorkspace({ 'src/a.ts': 'content that the fake rg does not inspect\n' });

    const result = await withRipgrepReturningNoMatches(() =>
      runLiveGrep(
        {
          caseSensitive: false,
          contextLines: 0,
          isRegex: false,
          pattern: 'ABSENT_TOKEN',
          roots: [root(dir)],
        },
        literalMatcher('ABSENT_TOKEN')
      )
    );

    expect(result.engine).toBe('ripgrep');
    expect(result.matches).toEqual([]);
    expect(result.note).toBeUndefined();
    expect(loggerWarnMock).not.toHaveBeenCalled();
  });

  it('respects the ignore policy (skips node_modules and build output)', async () => {
    const dir = await makeWorkspace({
      'dist/bundle.ts': 'IGNORE_PROBE bundle\n',
      'node_modules/dep/index.ts': 'IGNORE_PROBE dep\n',
      'src/keep.ts': 'IGNORE_PROBE keep\n',
    });
    const result = await runLiveGrep(
      {
        caseSensitive: false,
        contextLines: 0,
        isRegex: false,
        pattern: 'IGNORE_PROBE',
        roots: [root(dir)],
      },
      literalMatcher('IGNORE_PROBE')
    );
    expect(result.matches.map((m) => m.path)).toEqual(['src/keep.ts']);
  });

  it('scopes each root and labels matches across multiple roots', async () => {
    const dirA = await makeWorkspace({ 'a.ts': 'MULTI here\n' }, 'brainstrike-livegrep-a-');
    const dirB = await makeWorkspace({ 'b.ts': 'MULTI there\n' }, 'brainstrike-livegrep-b-');
    const result = await runLiveGrep(
      {
        caseSensitive: false,
        contextLines: 0,
        isRegex: false,
        pattern: 'MULTI',
        roots: [root(dirA, 'id-a', 'alpha'), root(dirB, 'id-b', 'beta')],
      },
      literalMatcher('MULTI')
    );
    const labelled = result.matches.map((m) => `${m.rootName}/${m.path}`).sort();
    expect(labelled).toEqual(['alpha/a.ts', 'beta/b.ts']);
  });
});

describe('runLiveGrep — rg-absent fallback (non-silent)', () => {
  it('uses the JS file-walk and emits a note when ripgrep is unavailable', async () => {
    const dir = await makeWorkspace({ 'src/walk.ts': 'WALKING_TOKEN line\n' });

    const realStat = fsPromises.stat.bind(fsPromises);
    const statSpy = vi
      .spyOn(fsPromises, 'stat')
      .mockImplementation(async (target: Parameters<typeof realStat>[0]) => {
        if (typeof target === 'string' && target.endsWith('/rg')) {
          throw new Error('ENOENT: no ripgrep');
        }
        return realStat(target);
      });

    try {
      const result = await runLiveGrep(
        {
          caseSensitive: false,
          contextLines: 0,
          isRegex: false,
          pattern: 'WALKING_TOKEN',
          roots: [root(dir)],
        },
        literalMatcher('WALKING_TOKEN')
      );
      expect(result.engine).toBe('js-walk');
      expect(result.matches.map((m) => m.path)).toEqual(['src/walk.ts']);
      expect(result.note).toMatch(/ripgrep is unavailable/i);
    } finally {
      statSpy.mockRestore();
    }
  });
});

describe('runLiveGrep — path containment (symlink escape)', () => {
  it('does not follow a symlink whose target lives outside the root', async () => {
    const dir = await makeWorkspace({ 'src/inside.ts': 'ESCAPE_PROBE inside\n' });
    const outside = await makeWorkspace(
      { 'secret.ts': 'ESCAPE_PROBE outside\n' },
      'brainstrike-livegrep-out-'
    );
    await fsPromises.symlink(path.join(outside, 'secret.ts'), path.join(dir, 'src', 'escape.ts'));
    await fsPromises.symlink(outside, path.join(dir, 'linkdir'));

    const result = await runLiveGrep(
      {
        caseSensitive: false,
        contextLines: 0,
        isRegex: false,
        pattern: 'ESCAPE_PROBE',
        roots: [root(dir)],
      },
      literalMatcher('ESCAPE_PROBE')
    );
    const paths = result.matches.map((m) => m.path);
    expect(paths).toEqual(['src/inside.ts']);
    expect(paths.some((p) => p.includes('secret') || p.includes('escape'))).toBe(false);
  });
});

describe('runLiveGrep — regex + filePaths scoping', () => {
  it('matches a regex pattern via the shared matcher', async () => {
    const dir = await makeWorkspace({ 'src/r.ts': 'value = REGEX_42 end\n' });
    const result = await runLiveGrep(
      {
        caseSensitive: false,
        contextLines: 0,
        isRegex: true,
        pattern: 'REGEX_\\d+',
        roots: [root(dir)],
      },
      createGrepLineMatcher('REGEX_\\d+', true, false)
    );
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.lineText).toContain('REGEX_42');
  });

  it('restricts matches to the filePaths allowlist', async () => {
    const dir = await makeWorkspace({
      'src/drop.ts': 'ALLOW_PROBE drop\n',
      'src/keep.ts': 'ALLOW_PROBE keep\n',
    });
    const result = await runLiveGrep(
      {
        caseSensitive: false,
        contextLines: 0,
        filePaths: ['src/keep.ts'],
        isRegex: false,
        pattern: 'ALLOW_PROBE',
        roots: [root(dir)],
      },
      literalMatcher('ALLOW_PROBE')
    );
    expect(result.matches.map((m) => m.path)).toEqual(['src/keep.ts']);
  });
});

describe('runLiveGrep — ignore-filter superset (rg does not drop gitignored/hidden files)', () => {
  it('rg prefilter FINDS a gitignored-but-present file (policy is the sole authority)', async () => {
    const realRg = await findRealRipgrep();
    if (realRg === null) {
      // This assertion is rg-specific: it proves rg no longer drops files its OWN
      // .gitignore/hidden filtering would. The JS-walk fallback never consulted
      // .gitignore, so without rg there is nothing to prove here. Skip cleanly.
      return;
    }
    // A real git repo whose .gitignore lists a fresh, indexable SOURCE file
    // (`src/generated-config.ts` — kept by the indexer policy) plus node_modules.
    // Default rg would drop the gitignored source file (vcs ignore); node_modules
    // is dropped by the indexer policy. With the superset fix, rg surfaces BOTH
    // and the policy (re-applied in resolveCandidate) is the sole authority: the
    // gitignored source file is KEPT (it is fresh on disk), node_modules dropped.
    const dir = await makeWorkspace({
      '.gitignore': 'node_modules/\nsrc/generated-config.ts\n',
      'node_modules/dep/index.ts': 'SUPERSET_TOKEN dep\n',
      'src/generated-config.ts': 'SUPERSET_TOKEN gitignored-but-present\n',
      'src/tracked.ts': 'SUPERSET_TOKEN tracked\n',
    });
    // Make it a real git repo so rg's vcs-ignore (which the superset fix disables)
    // would otherwise apply to the gitignored file.
    await fsPromises.mkdir(path.join(dir, '.git'), { recursive: true });
    await fsPromises.writeFile(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');

    const result = await runLiveGrep(
      {
        caseSensitive: false,
        contextLines: 0,
        isRegex: false,
        pattern: 'SUPERSET_TOKEN',
        roots: [root(dir)],
      },
      literalMatcher('SUPERSET_TOKEN')
    );

    // rg actually ran (this is the path under test) …
    expect(result.engine).toBe('ripgrep');
    const paths = result.matches.map((m) => m.path).sort();
    // … and it surfaced the gitignored-but-present source file (NOT dropped) …
    expect(paths).toContain('src/generated-config.ts');
    expect(paths).toContain('src/tracked.ts');
    // … while the indexer policy (the sole authority) still drops node_modules.
    expect(paths.some((p) => p.startsWith('node_modules/'))).toBe(false);
  });

  it('rg prefilter still excludes node_modules/.git via the indexer policy', async () => {
    const realRg = await findRealRipgrep();
    if (realRg === null) {
      return;
    }
    const dir = await makeWorkspace({
      'dist/bundle.js': 'POLICY_TOKEN bundle\n',
      'node_modules/dep/index.ts': 'POLICY_TOKEN dep\n',
      'src/keep.ts': 'POLICY_TOKEN keep\n',
    });
    // A .git directory with a file that contains the token: rg --hidden would
    // surface it, but resolveCandidate hard-excludes any `.git` path segment.
    await fsPromises.mkdir(path.join(dir, '.git'), { recursive: true });
    await fsPromises.writeFile(path.join(dir, '.git', 'config'), 'POLICY_TOKEN gitdir\n', 'utf8');

    const result = await runLiveGrep(
      {
        caseSensitive: false,
        contextLines: 0,
        isRegex: false,
        pattern: 'POLICY_TOKEN',
        roots: [root(dir)],
      },
      literalMatcher('POLICY_TOKEN')
    );
    expect(result.engine).toBe('ripgrep');
    expect(result.matches.map((m) => m.path)).toEqual(['src/keep.ts']);
  });
});

describe('runLiveGrep — regex superset soundness (no silent miss)', () => {
  it('regex WITH an extractable literal: rg prefilters on the literal, match not missed', async () => {
    const realRg = await findRealRipgrep();
    if (realRg === null) {
      // The extractable-literal regex case via the rg path; the rg-absent walk is
      // covered by the no-literal cases below and by the basics suite.
      return;
    }
    // `CONFIG_[A-Z]+_VALUE` extracts the guaranteed literal `CONFIG_`; rg
    // prefilters on that fixed string (a superset) and the JS regex confirms the
    // line. A file whose line the JS regex matches must not be dropped by rg.
    const dir = await makeWorkspace({
      'src/match.ts': 'const CONFIG_ENABLED_VALUE = 1;\n',
      'src/nomatch.ts': 'const CONFIGURED = 2;\n',
    });
    const pattern = 'CONFIG_[A-Z]+_VALUE';
    const result = await runLiveGrep(
      {
        caseSensitive: false,
        contextLines: 0,
        isRegex: true,
        pattern,
        roots: [root(dir)],
      },
      regexMatcher(pattern)
    );
    expect(result.engine).toBe('ripgrep');
    expect(result.matches.map((m) => m.path)).toEqual(['src/match.ts']);
    expect(result.matches[0]?.lineText).toContain('CONFIG_ENABLED_VALUE');
  });

  it('regex with NO extractable literal: bounded JS walk is used, not rg (match found, not missed)', async () => {
    const realRg = await findRealRipgrep();
    if (realRg === null) {
      // Without rg the walk runs anyway; the point of THIS case is to prove that
      // even WITH rg present we do NOT trust its raw-regex match for a literal-
      // free pattern. So it only proves something when rg is installed.
      return;
    }
    // `\d{4,}` has no ≥3-char guaranteed literal (extractTrigramLiteral → null),
    // so rg cannot prefilter it as a guaranteed superset. The live pass must take
    // the bounded JS walk and let the authoritative matcher decide — never hand
    // rg the raw regex (whose Rust dialect could match a narrower set).
    const dir = await makeWorkspace({ 'src/num.ts': 'id = 12345 done\n' });
    const pattern = '\\d{4,}';
    const result = await runLiveGrep(
      {
        caseSensitive: false,
        contextLines: 0,
        isRegex: true,
        pattern,
        roots: [root(dir)],
      },
      regexMatcher(pattern)
    );
    // rg is present but was deliberately NOT used (no safe superset literal).
    expect(result.engine).toBe('js-walk');
    // The match is still found by the authoritative JS matcher over the walk.
    expect(result.matches.map((m) => m.path)).toEqual(['src/num.ts']);
    expect(result.matches[0]?.lineText).toContain('12345');
    // Non-silent: the note explains the prefilter-free scan (mirrors the indexed
    // path's scanLimited regex case).
    expect(result.note).toMatch(/without a ripgrep prefilter/i);
  });

  it('regex with an ESCAPE-encoded literal (\\x66oo matches "foo") is found, not silently missed', async () => {
    // `\x66oo` decodes to `foo` in JS RegExp (\x66 = 'f'). The literal extractor
    // must NOT yield the mis-decoded fixed string `66oo` (which rg would prefilter
    // on and find nothing → silent miss). Instead it returns null for the escape-
    // laden pattern, so the live pass takes the bounded JS walk and the
    // authoritative matcher finds the `foo` line. Proven with rg present so the
    // "rg deliberately not used for a mis-decodable literal" path is exercised.
    const dir = await makeWorkspace({
      'src/decoy.ts': 'value = 66oo end\n',
      'src/escaped.ts': 'value = foobar end\n',
    });
    const pattern = '\\x66oo';
    // Sanity: the authoritative matcher matches the `foo` line, not the `66oo` one.
    expect(regexMatcher(pattern).matches('value = foobar end')).toBe(true);
    expect(regexMatcher(pattern).matches('value = 66oo end')).toBe(false);

    const result = await runLiveGrep(
      {
        caseSensitive: false,
        contextLines: 0,
        isRegex: true,
        pattern,
        roots: [root(dir)],
      },
      regexMatcher(pattern)
    );
    // No safe fixed-string literal → JS walk, not a mis-decoded rg prefilter.
    expect(result.engine).toBe('js-walk');
    // The `foo` (foobar) line is FOUND; the `66oo` decoy is NOT matched.
    expect(result.matches.map((m) => m.path)).toEqual(['src/escaped.ts']);
    expect(result.matches[0]?.lineText).toContain('foobar');
  });

  it('regex with NO extractable literal also finds the match when rg is absent', async () => {
    // Force rg absent so the walk path is exercised on CI (no rg) too: the same
    // literal-free regex must still find its on-disk match via the JS matcher.
    const binDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-livegrep-rxn-'));
    createdRoots.push(binDir);
    process.env['PATH'] = binDir;
    const realStat = fsPromises.stat.bind(fsPromises);
    const statSpy = vi
      .spyOn(fsPromises, 'stat')
      .mockImplementation(async (target: Parameters<typeof realStat>[0]) => {
        if (typeof target === 'string' && (target.endsWith('/rg') || target.endsWith('\\rg.exe'))) {
          throw new Error('ENOENT: ripgrep not found');
        }
        return realStat(target);
      });
    resetRipgrepAvailabilityForTests();

    try {
      const dir = await makeWorkspace({ 'src/n.ts': 'value=98765 end\n' });
      const pattern = '\\d{4,}';
      const result = await runLiveGrep(
        {
          caseSensitive: false,
          contextLines: 0,
          isRegex: true,
          pattern,
          roots: [root(dir)],
        },
        regexMatcher(pattern)
      );
      expect(result.engine).toBe('js-walk');
      expect(result.matches.map((m) => m.path)).toEqual(['src/n.ts']);
      expect(result.matches[0]?.lineText).toContain('98765');
    } finally {
      statSpy.mockRestore();
    }
  });
});

describe('runLiveGrep — binary-detection superset (--text; NUL-containing source files)', () => {
  it('rg FINDS a policy-included .ts file that contains a NUL byte before the match', async () => {
    const realRg = await findRealRipgrep();
    if (realRg === null) {
      // rg-specific: it proves rg no longer drops a NUL-containing source file via
      // its content heuristic. The JS-walk reads everything as utf8 regardless, so
      // there is nothing rg-specific to prove without rg installed. Skip cleanly.
      return;
    }
    // `src/a.ts` has a NUL byte BEFORE the match: default rg's binary heuristic
    // skips it (no `begin` event → never a candidate), but the extension-based
    // policy INCLUDES it and the js-walk reads it as utf8 and matches. With
    // `--text`, rg surfaces it too — restoring the superset.
    const dir = await makeWorkspace({
      'src/a.ts': 'line one   some bytes\nBINTOKEN appears here\n',
      'src/clean.ts': 'BINTOKEN clean\n',
    });
    const result = await runLiveGrep(
      {
        caseSensitive: false,
        contextLines: 0,
        isRegex: false,
        pattern: 'BINTOKEN',
        roots: [root(dir)],
      },
      literalMatcher('BINTOKEN')
    );
    expect(result.engine).toBe('ripgrep');
    // BOTH files surface — the NUL-containing one is no longer silently dropped.
    expect(result.matches.map((m) => m.path).sort()).toEqual(['src/a.ts', 'src/clean.ts']);
  });

  it('rg-vs-walk parity: the rg pass and the js-walk pass AGREE on a mixed workspace', async () => {
    const realRg = await findRealRipgrep();
    if (realRg === null) {
      // Parity is asserted by running BOTH engines on the SAME workspace; without
      // a real rg there is no rg side to compare against. Skip cleanly.
      return;
    }
    // A deliberately adversarial mix: a plain match, a NUL-containing match (the
    // binary-heuristic trap), a gitignored-but-present match (the vcs-ignore
    // trap), a dotfile match (the hidden trap), and policy-excluded files
    // (node_modules, a .min.js, .git) that NEITHER engine should surface.
    const dir = await makeWorkspace({
      '.config-probe.ts': 'PARITY_TOKEN dotfile\n',
      '.gitignore': 'node_modules/\nsrc/ignored.ts\n',
      'node_modules/dep/index.ts': 'PARITY_TOKEN dep\n',
      'src/ignored.ts': 'PARITY_TOKEN gitignored\n',
      'src/plain.ts': 'PARITY_TOKEN plain\n',
      'src/withnul.ts': 'before   nul\nPARITY_TOKEN after a nul\n',
      'vendor/lib.min.js': 'PARITY_TOKEN minified\n',
    });
    await fsPromises.mkdir(path.join(dir, '.git'), { recursive: true });
    await fsPromises.writeFile(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    await fsPromises.writeFile(path.join(dir, '.git', 'config'), 'PARITY_TOKEN gitdir\n', 'utf8');

    const options = {
      caseSensitive: false,
      contextLines: 0,
      isRegex: false,
      pattern: 'PARITY_TOKEN',
      roots: [root(dir)],
    };

    // rg engine (rg present on this host) …
    const rgResult = await runLiveGrep(options, literalMatcher('PARITY_TOKEN'));
    expect(rgResult.engine).toBe('ripgrep');
    // … and the js-walk engine on the IDENTICAL workspace (rg forced absent).
    const walkResult = await withRipgrepHidden(() =>
      runLiveGrep(options, literalMatcher('PARITY_TOKEN'))
    );
    expect(walkResult.engine).toBe('js-walk');

    const rgPaths = rgResult.matches.map((m) => m.path).sort();
    const walkPaths = walkResult.matches.map((m) => m.path).sort();
    // The two candidate/match sets are IDENTICAL — rg is a true superset and the
    // policy (the sole authority) trims both to the same set. This is the direct
    // assertion the earlier coverage gap was missing.
    expect(rgPaths).toEqual(walkPaths);
    // Concretely: the fresh source files are present (incl. NUL/gitignored/dotfile)
    // and the policy-excluded artifacts are absent from BOTH.
    expect(rgPaths).toEqual([
      '.config-probe.ts',
      'src/ignored.ts',
      'src/plain.ts',
      'src/withnul.ts',
    ]);
  });
});

describe('runLiveGrep — rg prunes .git/node_modules at the rg level (perf + parity)', () => {
  it('does NOT surface node_modules/.git matches (pruned by glob), but DOES surface src', async () => {
    const realRg = await findRealRipgrep();
    if (realRg === null) {
      // rg-specific: the `--glob=!**/.git/` + `--glob=!**/node_modules/` pruning
      // happens inside rg. The JS walk prunes the same dirs at its own boundary,
      // so there is nothing rg-specific to prove without rg installed. Skip.
      return;
    }
    // node_modules and .git both contain the token. `--no-ignore --hidden` would
    // make rg DESCEND into them without the prune globs; the globs prune them at
    // the rg level (matching the JS walk's directory pruning), so neither appears.
    const dir = await makeWorkspace({
      'node_modules/dep/index.ts': 'PRUNE_PROBE dep\n',
      'node_modules/dep/nested/deep.ts': 'PRUNE_PROBE deep\n',
      'src/keep.ts': 'PRUNE_PROBE keep\n',
    });
    await fsPromises.mkdir(path.join(dir, '.git'), { recursive: true });
    await fsPromises.writeFile(path.join(dir, '.git', 'config'), 'PRUNE_PROBE gitdir\n', 'utf8');

    const result = await runLiveGrep(
      {
        caseSensitive: false,
        contextLines: 0,
        isRegex: false,
        pattern: 'PRUNE_PROBE',
        roots: [root(dir)],
      },
      literalMatcher('PRUNE_PROBE')
    );
    expect(result.engine).toBe('ripgrep');
    // Only the src file survives — node_modules/.git are pruned before resolveCandidate.
    expect(result.matches.map((m) => m.path)).toEqual(['src/keep.ts']);
    expect(result.matches.some((m) => m.path.startsWith('node_modules/'))).toBe(false);
    expect(result.matches.some((m) => m.path.includes('.git'))).toBe(false);
  });

  it('rg-vs-walk parity holds with node_modules/.git present (both exclude them)', async () => {
    const realRg = await findRealRipgrep();
    if (realRg === null) {
      return;
    }
    const dir = await makeWorkspace({
      'node_modules/dep/index.ts': 'NMGIT_TOKEN dep\n',
      'src/a.ts': 'NMGIT_TOKEN a\n',
      'src/b.ts': 'NMGIT_TOKEN b\n',
    });
    await fsPromises.mkdir(path.join(dir, '.git'), { recursive: true });
    await fsPromises.writeFile(path.join(dir, '.git', 'config'), 'NMGIT_TOKEN gitdir\n', 'utf8');

    const options = {
      caseSensitive: false,
      contextLines: 0,
      isRegex: false,
      pattern: 'NMGIT_TOKEN',
      roots: [root(dir)],
    };
    const rgResult = await runLiveGrep(options, literalMatcher('NMGIT_TOKEN'));
    expect(rgResult.engine).toBe('ripgrep');
    const walkResult = await withRipgrepHidden(() =>
      runLiveGrep(options, literalMatcher('NMGIT_TOKEN'))
    );
    expect(walkResult.engine).toBe('js-walk');

    const rgPaths = rgResult.matches.map((m) => m.path).sort();
    const walkPaths = walkResult.matches.map((m) => m.path).sort();
    expect(rgPaths).toEqual(walkPaths);
    expect(rgPaths).toEqual(['src/a.ts', 'src/b.ts']);
  });
});

describe('runLiveGrep — ripgrep discovery (PATH, not a hardcoded location)', () => {
  it('finds rg via a PATH entry that is NOT a hardcoded fallback dir', async () => {
    const realRg = await findRealRipgrep();
    if (realRg === null) {
      // No rg on the machine running this suite — discovery-via-PATH can't be
      // exercised; the rg-absent fallback is covered separately. Skip cleanly.
      return;
    }
    // A temp bin dir holding ONLY a symlink to the real rg. Pointing PATH at it
    // (and nothing else) proves rg is resolved from PATH, since this dir is not
    // in the hardcoded fallback list (/opt/homebrew/bin, /usr/local/bin, ...).
    const binDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-livegrep-bin-'));
    createdRoots.push(binDir);
    const pathRg = path.join(binDir, 'rg');
    await fsPromises.symlink(realRg, pathRg);
    process.env['PATH'] = binDir;
    resetRipgrepAvailabilityForTests();

    // Discovery resolved rg from the PATH entry — the resolved path is INSIDE the
    // temp bin dir, NOT a hardcoded fallback like /opt/homebrew/bin. This is the
    // discriminating assertion: a hardcoded resolver would return the fallback.
    expect(await discoverRipgrepPathForTests()).toBe(pathRg);

    const dir = await makeWorkspace({ 'src/p.ts': 'PATH_DISCOVERY_TOKEN here\n' });
    const result = await runLiveGrep(
      {
        caseSensitive: false,
        contextLines: 0,
        isRegex: false,
        pattern: 'PATH_DISCOVERY_TOKEN',
        roots: [root(dir)],
      },
      literalMatcher('PATH_DISCOVERY_TOKEN')
    );

    // Resolved rg via the PATH entry → ripgrep engine (not the JS-walk fallback).
    expect(result.engine).toBe('ripgrep');
    expect(result.matches.map((m) => m.path)).toEqual(['src/p.ts']);
    expect(result.note).toBeUndefined();
  });

  it('falls back to the JS file-walk (with a note) when rg is on NO PATH entry', async () => {
    // An empty bin dir on PATH and the fallback-dir probes forced to miss: rg is
    // genuinely unreachable, so the live pass must degrade to the JS walk.
    const binDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-livegrep-norg-'));
    createdRoots.push(binDir);
    process.env['PATH'] = binDir;

    // The discovery probe stats every candidate `.../rg`; make those misses while
    // leaving workspace stats intact, so neither PATH nor the fallback dirs hit.
    const realStat = fsPromises.stat.bind(fsPromises);
    const statSpy = vi
      .spyOn(fsPromises, 'stat')
      .mockImplementation(async (target: Parameters<typeof realStat>[0]) => {
        if (typeof target === 'string' && (target.endsWith('/rg') || target.endsWith('\\rg.exe'))) {
          throw new Error('ENOENT: ripgrep not found');
        }
        return realStat(target);
      });
    resetRipgrepAvailabilityForTests();

    try {
      const dir = await makeWorkspace({ 'src/w.ts': 'NOPATH_TOKEN here\n' });
      const result = await runLiveGrep(
        {
          caseSensitive: false,
          contextLines: 0,
          isRegex: false,
          pattern: 'NOPATH_TOKEN',
          roots: [root(dir)],
        },
        literalMatcher('NOPATH_TOKEN')
      );
      expect(result.engine).toBe('js-walk');
      expect(result.matches.map((m) => m.path)).toEqual(['src/w.ts']);
      expect(result.note).toMatch(/ripgrep is unavailable/i);
    } finally {
      statSpy.mockRestore();
    }
  });
});

describe('runLiveGrep — candidate cap bounds the resolve (truncated)', () => {
  it('stops resolving at the cap and surfaces truncated when more candidates exist', async () => {
    // Six files all match; cap the live pass at 2 so resolve MUST stop early.
    const dir = await makeWorkspace({
      'src/c1.ts': 'CAP_TOKEN one\n',
      'src/c2.ts': 'CAP_TOKEN two\n',
      'src/c3.ts': 'CAP_TOKEN three\n',
      'src/c4.ts': 'CAP_TOKEN four\n',
      'src/c5.ts': 'CAP_TOKEN five\n',
      'src/c6.ts': 'CAP_TOKEN six\n',
    });
    setMaxLiveCandidateFilesForTests(2);

    const result = await runLiveGrep(
      {
        caseSensitive: false,
        contextLines: 0,
        isRegex: false,
        pattern: 'CAP_TOKEN',
        roots: [root(dir)],
      },
      literalMatcher('CAP_TOKEN')
    );

    // Resolution stopped at the cap (2 candidate files), so at most 2 matches.
    expect(result.matches.length).toBeLessThanOrEqual(2);
    // …and the cap is surfaced (never silent) so the model knows more exist.
    expect(result.truncated).toBe(true);
    expect(result.note).toMatch(/candidate-file cap/i);
  });
});
