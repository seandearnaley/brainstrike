import type { RuntimeWorkspaceRoot } from '@brainstrike/assistant-contract';
import { describe, expect, it } from 'vitest';
import { resolveGrepFilePaths } from '../../assistant-server/grep-file-paths';

/**
 * BST-764. `runLiveGrep` used to normalize every allowlisted path with only
 * `p.replace(/^\/+/, '')`, so an absolute path became `Users/sean/...` — which
 * can never equal the root-relative candidate `proof.html`. The live pass then
 * reported a clean zero-match result instead of rejecting the malformed scope,
 * and a hosted model abandoned native grep for shell commands.
 *
 * Grep matches root-relative paths (roots can share a relative path), so the
 * search and its probes take one normalized allowlist.
 */

const ROOT_A: RuntimeWorkspaceRoot = {
  displayName: 'site-qa',
  path: '/Users/sean/Documents/site-qa',
  rootId: 'root-a',
};
const ROOT_B: RuntimeWorkspaceRoot = {
  displayName: 'brainstrike',
  path: '/Users/sean/Documents/brainstrike',
  rootId: 'root-b',
};

function resolve(filePaths: readonly string[] | undefined, roots = [ROOT_A]) {
  return resolveGrepFilePaths({ filePaths, roots, scopedRoot: undefined });
}

describe('resolveGrepFilePaths — absent allowlist', () => {
  it('passes undefined through as "no filter"', () => {
    expect(resolve(undefined)).toEqual({ filePaths: undefined, ok: true, rootIds: undefined });
  });

  it('preserves an explicitly empty allowlist as "nothing allowed"', () => {
    // Existing semantics in the repository layer: an empty allowlist matches
    // nothing. Silently upgrading it to "no filter" would widen the search.
    expect(resolve([])).toEqual({ filePaths: [], ok: true, rootIds: undefined });
  });
});

describe('resolveGrepFilePaths — the reported defect', () => {
  it('converts an absolute path inside the single mounted root to root-relative', () => {
    // The exact shape from the BST-764 reproduction.
    const result = resolve(['/Users/sean/Documents/site-qa/claude-haiku-proof.html']);
    expect(result).toEqual({
      filePaths: ['claude-haiku-proof.html'],
      ok: true,
      rootIds: ['root-a'],
    });
  });

  it('handles an absolute path in a nested subdirectory of the root', () => {
    const result = resolve(['/Users/sean/Documents/site-qa/src/deep/file.ts']);
    expect(result).toEqual({ filePaths: ['src/deep/file.ts'], ok: true, rootIds: ['root-a'] });
  });

  it('accepts an already-root-relative path unchanged', () => {
    expect(resolve(['claude-haiku-proof.html'])).toEqual({
      filePaths: ['claude-haiku-proof.html'],
      ok: true,
      rootIds: undefined,
    });
    expect(resolve(['./src/file.ts'])).toEqual({
      filePaths: ['src/file.ts'],
      ok: true,
      rootIds: undefined,
    });
  });
});

describe('resolveGrepFilePaths — rejects rather than returning a misleading empty result', () => {
  it('rejects an absolute path outside every mounted root', () => {
    const result = resolve(['/etc/passwd']);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('unreachable');
    }
    // Model-actionable: names the offending path AND the folders it could use.
    expect(result.message).toContain('/etc/passwd');
    expect(result.message).toContain('/Users/sean/Documents/site-qa');
  });

  it('rejects a relative path that escapes the root via traversal', () => {
    const result = resolve(['../outside/secrets.txt']);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('unreachable');
    }
    expect(result.message).toMatch(/outside|escape|traversal/iu);
  });

  it('rejects an absolute path that traverses out of a root', () => {
    const result = resolve(['/Users/sean/Documents/site-qa/../brainstrike/secret.ts']);
    expect(result.ok).toBe(false);
  });

  it('rejects a blank entry instead of silently dropping it', () => {
    const result = resolve(['   ']);
    expect(result.ok).toBe(false);
  });

  it('never returns ok with an empty list for a non-empty input', () => {
    // The core anti-regression: the ONLY way to get an empty allowlist is to
    // ask for one. Anything else that cannot be resolved must be an error, or
    // we are back to a clean zero-match result for a valid file.
    for (const bad of ['/etc/passwd', '../escape.txt', '   ']) {
      const result = resolve([bad]);
      expect(result.ok, `${bad} must not resolve`).toBe(false);
    }
  });
});

describe('resolveGrepFilePaths — multi-root', () => {
  const roots = [ROOT_A, ROOT_B];

  it('routes each absolute path to whichever root contains it', () => {
    const result = resolveGrepFilePaths({
      filePaths: ['/Users/sean/Documents/site-qa/a.html', '/Users/sean/Documents/brainstrike/b.ts'],
      roots,
      scopedRoot: undefined,
    });
    expect(result).toEqual({
      filePaths: ['a.html', 'b.ts'],
      ok: true,
      rootIds: ['root-a', 'root-b'],
    });
  });

  it('rejects an absolute path under a nested root as ambiguous', () => {
    // A root mounted inside another root makes the relative form ambiguous:
    // the same path would address different files depending on the root.
    const nested: RuntimeWorkspaceRoot = {
      displayName: 'inner',
      path: '/Users/sean/Documents/site-qa/inner',
      rootId: 'root-c',
    };
    const result = resolveGrepFilePaths({
      filePaths: ['/Users/sean/Documents/site-qa/inner/file.ts'],
      roots: [ROOT_A, nested],
      scopedRoot: undefined,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('unreachable');
    }
    expect(result.message).toMatch(/ambiguous|more than one|multiple/iu);
  });

  it('resolves an otherwise-ambiguous path against an explicitly scoped root', () => {
    // `root` is the caller's own disambiguation, so honour it rather than
    // failing a call the model already qualified.
    const nested: RuntimeWorkspaceRoot = {
      displayName: 'inner',
      path: '/Users/sean/Documents/site-qa/inner',
      rootId: 'root-c',
    };
    const result = resolveGrepFilePaths({
      filePaths: ['/Users/sean/Documents/site-qa/inner/file.ts'],
      roots: [ROOT_A, nested],
      scopedRoot: nested,
    });
    expect(result).toEqual({ filePaths: ['file.ts'], ok: true, rootIds: ['root-c'] });
  });

  it('rejects an absolute path outside the explicitly scoped root', () => {
    const result = resolveGrepFilePaths({
      filePaths: ['/Users/sean/Documents/brainstrike/b.ts'],
      roots,
      scopedRoot: ROOT_A,
    });
    expect(result.ok).toBe(false);
  });
});

describe('resolveGrepFilePaths — no path-backed roots', () => {
  it('rejects an absolute path when there is nothing to resolve it against', () => {
    // Silently keeping the absolute path would reproduce the original bug: a
    // never-matching allowlist reported as a clean zero-match.
    const result = resolveGrepFilePaths({
      filePaths: ['/Users/sean/Documents/site-qa/a.html'],
      roots: [],
      scopedRoot: undefined,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('unreachable');
    }
    expect(result.message).toMatch(/no open folder|not open|no workspace/iu);
  });

  it('still accepts relative paths with no roots (the indexed pass can match them)', () => {
    expect(
      resolveGrepFilePaths({ filePaths: ['a.html'], roots: [], scopedRoot: undefined })
    ).toEqual({ filePaths: ['a.html'], ok: true, rootIds: undefined });
  });
});

describe('resolveGrepFilePaths — normalization details', () => {
  it('deduplicates paths that normalize to the same root-relative form', () => {
    const result = resolve(['/Users/sean/Documents/site-qa/a.html', 'a.html', './a.html']);
    expect(result).toEqual({ filePaths: ['a.html'], ok: true, rootIds: ['root-a'] });
  });

  it('collapses redundant separators and inner dot segments', () => {
    expect(resolve(['src//deep/./file.ts'])).toEqual({
      filePaths: ['src/deep/file.ts'],
      ok: true,
      rootIds: undefined,
    });
  });

  it('does not treat a sibling directory with a shared prefix as inside the root', () => {
    // `/Users/sean/Documents/site-qa-backup` starts with the root path as a
    // STRING but is a different directory. A naive startsWith would smuggle it
    // in and produce a garbage relative path.
    const result = resolve(['/Users/sean/Documents/site-qa-backup/a.html']);
    expect(result.ok).toBe(false);
  });

  it('resolves the root directory itself to an empty relative path rejection', () => {
    // Scoping a file allowlist to the root directory itself is not a file.
    const result = resolve(['/Users/sean/Documents/site-qa']);
    expect(result.ok).toBe(false);
  });
});

describe('resolveGrepFilePaths — root identity (review follow-up on #2087)', () => {
  it('reports the owning root of an absolute entry so both passes can pin to it', () => {
    const result = resolveGrepFilePaths({
      filePaths: ['/Users/sean/Documents/site-qa/proof.html'],
      roots: [ROOT_A, ROOT_B],
      scopedRoot: undefined,
    });
    expect(result).toEqual({ filePaths: ['proof.html'], ok: true, rootIds: ['root-a'] });
  });

  it('leaves rootIds undefined for a purely relative allowlist', () => {
    // A relative path carries no root information, so it must keep searching
    // every open root rather than being silently narrowed to one.
    expect(resolve(['src/x.ts'], [ROOT_A, ROOT_B])).toEqual({
      filePaths: ['src/x.ts'],
      ok: true,
      rootIds: undefined,
    });
  });

  it('reports every distinct owning root when absolute entries span roots', () => {
    const result = resolveGrepFilePaths({
      filePaths: ['/Users/sean/Documents/site-qa/a.html', '/Users/sean/Documents/brainstrike/b.ts'],
      roots: [ROOT_A, ROOT_B],
      scopedRoot: undefined,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('unreachable');
    }
    expect([...(result.rootIds ?? [])].sort()).toEqual(['root-a', 'root-b']);
  });
});

describe('resolveGrepFilePaths — Windows path shapes (review follow-up on #2087)', () => {
  it('rejects a UNC path rather than coercing it into a never-matching relative path', () => {
    // Previously `\\server\share\file.ts` satisfied neither absolute branch,
    // fell through to the relative handler, and became `server/share/file.ts`
    // — the BST-764 failure mode on a different input shape.
    const result = resolve(['\\\\server\\share\\repo\\src\\x.ts']);
    expect(result.ok).toBe(false);
  });

  it('rejects a drive-relative rooted path', () => {
    const result = resolve(['\\foo\\bar.ts']);
    expect(result.ok).toBe(false);
  });

  it('resolves a Windows drive path inside a matching root', () => {
    const winRoot: RuntimeWorkspaceRoot = {
      displayName: 'repo',
      path: 'C:\\Work\\Repo',
      rootId: 'root-win',
    };
    const result = resolveGrepFilePaths({
      filePaths: ['C:\\Work\\Repo\\src\\x.ts'],
      roots: [winRoot],
      scopedRoot: undefined,
    });
    expect(result).toEqual({ filePaths: ['src/x.ts'], ok: true, rootIds: ['root-win'] });
  });
});
