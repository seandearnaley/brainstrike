/**
 * Hybrid (index + live) coverage for `brainstrike.grepSearch`.
 *
 * These cases run the REAL live (on-disk) pass against a temp-dir workspace
 * while mocking ONLY the DB (the index pass) — so they exercise the actual
 * ripgrep/JS-walk discovery, the shared JS matcher, and the merge/dedup/label
 * logic end to end. The point: prove the agent sees FRESH content the index
 * would miss after an edit, and that index + live matches merge correctly.
 */
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeData } from '@brainstrike/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runGrepSearch } from '../../assistant-server/grep-search-tool';
import { resetRipgrepAvailabilityForTests } from '../../assistant-server/live-grep';

const queryMock = vi.fn();

vi.mock('../../db-main', () => ({
  getDatabase: vi.fn(async () => ({ query: queryMock })),
}));

vi.mock('@brainstrike/utils/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/utils/logger')>();
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    }),
  };
});

const createdRoots: string[] = [];

async function makeWorkspace(files: Record<string, string>): Promise<string> {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-hybrid-grep-'));
  createdRoots.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await fsPromises.mkdir(path.dirname(absolute), { recursive: true });
    await fsPromises.writeFile(absolute, content, 'utf8');
  }
  return root;
}

function singleRoot(rootPath: string): RuntimeData {
  return { workspaceRootPath: rootPath } as RuntimeData;
}

/** No indexed rows — the index pass returns zero matches. */
function indexEmpty(): void {
  queryMock.mockResolvedValue({ rows: [] });
}

beforeEach(() => {
  queryMock.mockReset();
  resetRipgrepAvailabilityForTests();
});

afterEach(async () => {
  resetRipgrepAvailabilityForTests();
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root) {
      await fsPromises.rm(root, { recursive: true, force: true });
    }
  }
});

describe('grepSearch hybrid — FRESHNESS (the point)', () => {
  it('returns just-written content the index does NOT have, labelled live', async () => {
    // A file that exists on disk but is NOT in the index (simulating a file the
    // agent just edited/created before re-indexing caught up).
    const root = await makeWorkspace({
      'src/fresh.ts': 'const FRESHLY_EDITED_TOKEN = 42;\n',
    });
    indexEmpty(); // index has NOTHING for this token

    const result = await runGrepSearch(
      { pattern: 'FRESHLY_EDITED_TOKEN', outputMode: 'content' },
      singleRoot(root)
    );
    if (result.outputMode !== 'content') {
      throw new Error('expected content result');
    }

    // The index missed it entirely; the LIVE pass found it fresh on disk.
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.path).toBe('src/fresh.ts');
    expect(result.matches[0]?.lineText).toContain('FRESHLY_EDITED_TOKEN');
    expect(result.matches[0]?.source).toBe('live');
    expect(result.liveEngine).toBe('ripgrep');
  });

  it('files mode: a fresh-only file is surveyed and labelled live', async () => {
    const root = await makeWorkspace({ 'a/only-on-disk.ts': 'WIDGET_BETA marker line\n' });
    indexEmpty();

    const result = await runGrepSearch({ pattern: 'WIDGET_BETA' }, singleRoot(root));
    if (result.outputMode !== 'files') {
      throw new Error('expected files result');
    }
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.path).toBe('a/only-on-disk.ts');
    expect(result.files[0]?.source).toBe('live');
  });
});

describe('grepSearch hybrid — merge / dedup / label', () => {
  it('labels a line found in BOTH index and live as "both" (counted once)', async () => {
    const root = await makeWorkspace({ 'src/x.ts': 'shared NEEDLE here\n' });
    // The index ALSO has the exact same (path, line) — startLine 1 → line 1.
    queryMock.mockResolvedValue({
      rows: [{ content: 'shared NEEDLE here', start_line: 1, path: 'src/x.ts' }],
    });

    const result = await runGrepSearch(
      { pattern: 'NEEDLE', outputMode: 'content' },
      singleRoot(root)
    );
    if (result.outputMode !== 'content') {
      throw new Error('expected content result');
    }
    // ONE merged match, labelled both.
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.path).toBe('src/x.ts');
    expect(result.matches[0]?.line).toBe(1);
    expect(result.matches[0]?.source).toBe('both');
    expect(result.totalMatches).toBe(1);
  });

  it('labels index-only and live-only matches distinctly in one result', async () => {
    // On disk: only fresh.ts has the token. Index: only stale.ts (no longer on
    // disk for that token) reports a match — an index-only hit.
    const root = await makeWorkspace({ 'src/fresh.ts': 'TOKEN on disk\n' });
    queryMock.mockResolvedValue({
      rows: [{ content: 'TOKEN in index', start_line: 7, path: 'src/stale.ts' }],
    });

    const result = await runGrepSearch(
      { pattern: 'TOKEN', outputMode: 'content' },
      singleRoot(root)
    );
    if (result.outputMode !== 'content') {
      throw new Error('expected content result');
    }
    const bySource = new Map(result.matches.map((m) => [m.path, m.source]));
    expect(bySource.get('src/fresh.ts')).toBe('live');
    expect(bySource.get('src/stale.ts')).toBe('index');
    expect(result.matches).toHaveLength(2);
  });
});

describe('grepSearch hybrid — rg-absent fallback (non-silent)', () => {
  it('falls back to the JS file-walk and still finds fresh content, with a note', async () => {
    const root = await makeWorkspace({ 'src/walked.ts': 'WALK_TOKEN present\n' });
    indexEmpty();

    // Force ripgrep "absent": the probe stats the rg binary path, so make that
    // one stat throw (ENOENT) while every other stat behaves normally.
    const realStat = fsPromises.stat.bind(fsPromises);
    const statSpy = vi
      .spyOn(fsPromises, 'stat')
      .mockImplementation(async (target: Parameters<typeof realStat>[0]) => {
        if (typeof target === 'string' && target.endsWith('/rg')) {
          throw new Error('ENOENT: ripgrep not found');
        }
        return realStat(target);
      });

    try {
      const result = await runGrepSearch(
        { pattern: 'WALK_TOKEN', outputMode: 'content' },
        singleRoot(root)
      );
      if (result.outputMode !== 'content') {
        throw new Error('expected content result');
      }
      // The fallback walk still found the fresh content.
      expect(result.matches).toHaveLength(1);
      expect(result.matches[0]?.path).toBe('src/walked.ts');
      expect(result.matches[0]?.source).toBe('live');
      // The degradation is surfaced (never silent) and the engine is js-walk.
      expect(result.liveEngine).toBe('js-walk');
      expect(result.liveNote).toBeDefined();
      expect(result.liveNote).toMatch(/ripgrep is unavailable/i);
    } finally {
      statSpy.mockRestore();
    }
  });
});

describe('grepSearch hybrid — path containment (symlink escape)', () => {
  it('does not return a symlinked file whose target lives outside the root', async () => {
    const root = await makeWorkspace({ 'src/inside.ts': 'SECRET_TOKEN inside\n' });
    const outside = await makeWorkspace({ 'secret.ts': 'SECRET_TOKEN outside\n' });

    // Symlink (file) pointing OUTSIDE the root, and a symlinked DIR outside.
    await fsPromises.symlink(path.join(outside, 'secret.ts'), path.join(root, 'src', 'escape.ts'));
    await fsPromises.symlink(outside, path.join(root, 'linkdir'));
    indexEmpty();

    const result = await runGrepSearch(
      { pattern: 'SECRET_TOKEN', outputMode: 'content' },
      singleRoot(root)
    );
    if (result.outputMode !== 'content') {
      throw new Error('expected content result');
    }
    // Only the in-root file is returned; the escaping symlink is dropped.
    const paths = result.matches.map((m) => m.path);
    expect(paths).toContain('src/inside.ts');
    expect(paths).not.toContain('src/escape.ts');
    expect(paths.some((p) => p.includes('secret.ts'))).toBe(false);
  });
});

describe('grepSearch hybrid — index unavailable but live works', () => {
  it('returns live-only results when the workspace is not indexed', async () => {
    const root = await makeWorkspace({ 'main.ts': 'UNINDEXED_MARKER value\n' });
    // Model an un-indexed workspace: the index pass returns nothing, so the
    // live pass is the SOLE source — grep still works without an index.
    indexEmpty();

    const result = await runGrepSearch({ pattern: 'UNINDEXED_MARKER' }, singleRoot(root));
    if (result.outputMode !== 'files') {
      throw new Error('expected files result');
    }
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.path).toBe('main.ts');
    expect(result.files[0]?.source).toBe('live');
    expect(result.totalMatches).toBe(1);
  });
});
