import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256OfFile } from '../../assistant-server/hooks/trust';
import {
  type DbRootLite,
  getProjectHooksForReview,
  resolveDbRootForPath,
  resolveTrustedRootIds,
} from '../../ipc-hooks-handlers';

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

let tmpRoot: string;

function writeProjectHooksBytes(rootAbsPath: string, bytes: Buffer): string {
  const dir = join(rootAbsPath, '.brainstrike');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'hooks.json');
  writeFileSync(file, bytes);
  return file;
}

/** A resolveDbRoot that treats `absPath` as the mounted root `db-r1` verbatim. */
function resolveTo(id: string, path: string): (absPath: string) => DbRootLite | null {
  return (absPath) => (absPath === path ? { id, path } : null);
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'bs-hooks-review-'));
});

afterEach(() => {
  rmSync(tmpRoot, { force: true, recursive: true });
});

describe('getProjectHooksForReview', () => {
  it('rejects a non-absolute root path', () => {
    const result = getProjectHooksForReview('r1', 'relative/path', {
      readFile: () => Buffer.alloc(0),
      resolveDbRoot: () => null,
    });
    expect(result.error).toMatch(/absolute/);
    expect(result.exists).toBe(false);
  });

  it('rejects an empty rootId', () => {
    const result = getProjectHooksForReview('', '/abs', {
      readFile: () => Buffer.alloc(0),
      resolveDbRoot: () => null,
    });
    expect(result.error).toMatch(/rootId/);
  });

  it('refuses a path that is not within any mounted workspace root (containment)', () => {
    const result = getProjectHooksForReview('r1', '/etc', {
      readFile: () => Buffer.from('{"PreToolUse":[]}', 'utf8'),
      resolveDbRoot: () => null,
    });
    // Fail closed: no DB root → no read, no content, structured error.
    expect(result.error).toMatch(/mounted workspace root/);
    expect(result.exists).toBe(false);
    expect(result.content).toBeUndefined();
  });

  it('reports exists:false when the file is missing (but the root resolved)', () => {
    const result = getProjectHooksForReview('r1', '/abs/root', {
      readFile: () => {
        throw new Error('ENOENT');
      },
      realpath: (p) => p,
      resolveDbRoot: resolveTo('db-root', '/abs/root'),
    });
    expect(result.exists).toBe(false);
    expect(result.path).toBe('/abs/root/.brainstrike/hooks.json');
    expect(result.dbRootId).toBe('db-root');
    expect(result.content).toBeUndefined();
  });

  it('returns content + sha256 + the resolved DB root id for a valid file', () => {
    const content = '{"PreToolUse":[]}';
    const result = getProjectHooksForReview('r1', '/abs/root', {
      readFile: () => Buffer.from(content, 'utf8'),
      realpath: (p) => p,
      resolveDbRoot: resolveTo('db-root', '/abs/root'),
    });
    expect(result.exists).toBe(true);
    expect(result.content).toBe(content);
    expect(result.sha256).toBe(sha256(content));
    expect(result.dbRootId).toBe('db-root');
    expect(result.parseError).toBeUndefined();
  });

  it('refuses a hooks file that symlinks out of its root (info-disclosure guard)', () => {
    const result = getProjectHooksForReview('r1', '/abs/root', {
      readFile: () => Buffer.from('{"PreToolUse":[]}', 'utf8'),
      // The hooks file realpaths OUTSIDE the root (symlink escape).
      realpath: (p) => (p === '/abs/root/.brainstrike/hooks.json' ? '/etc/passwd' : p),
      resolveDbRoot: resolveTo('db-root', '/abs/root'),
    });
    expect(result.error).toMatch(/outside the workspace root/);
    expect(result.exists).toBe(false);
    expect(result.content).toBeUndefined();
  });

  it('refuses a symlinked-out hooks file WITHOUT reading the target bytes', () => {
    // The containment check MUST run BEFORE any read: a `.brainstrike/hooks.json`
    // that symlinks OUT of its root would otherwise let main read (and return)
    // an arbitrary/large file's bytes before the later check refuses it.
    let readCount = 0;
    const result = getProjectHooksForReview('r1', '/abs/root', {
      readFile: () => {
        readCount += 1;
        throw new Error('the escaped target must never be read');
      },
      realpath: (p) => (p === '/abs/root/.brainstrike/hooks.json' ? '/etc/passwd' : p),
      resolveDbRoot: resolveTo('db-root', '/abs/root'),
    });
    expect(result.error).toMatch(/outside the workspace root/);
    expect(result.exists).toBe(false);
    expect(result.content).toBeUndefined();
    expect(readCount).toBe(0);
  });

  it('surfaces a parseError for malformed JSON but still returns content + hash', () => {
    const content = '{ not json';
    const result = getProjectHooksForReview('r1', '/abs/root', {
      readFile: () => Buffer.from(content, 'utf8'),
      realpath: (p) => p,
      resolveDbRoot: resolveTo('db-root', '/abs/root'),
    });
    expect(result.exists).toBe(true);
    expect(result.content).toBe(content);
    expect(result.sha256).toBe(sha256(content));
    expect(result.parseError).toBeDefined();
  });

  // M1: the review (approve-time) hash MUST be byte-identical to the server
  // trust-time hash (`sha256OfFile`). If the review hashed the utf8-DECODED
  // string while trust hashed the raw bytes, a file with non-utf8 bytes would
  // diverge → an approved root would be treated as untrusted and its hooks would
  // SILENTLY never run. Hash the RAW BYTES on both sides.
  it('hashes the raw file bytes, byte-identically to sha256OfFile (non-utf8 safe)', () => {
    const prefix = Buffer.from('{"PreToolUse":[{"command":"exit 2","description":"x', 'utf8');
    const suffix = Buffer.from('y","type":"command"}]}', 'utf8');
    const bytes = Buffer.concat([prefix, Buffer.from([0xff]), suffix]);
    const file = writeProjectHooksBytes(tmpRoot, bytes);

    const review = getProjectHooksForReview('r1', tmpRoot, {
      resolveDbRoot: resolveTo('db-root', tmpRoot),
    });

    expect(review.exists).toBe(true);
    expect(review.parseError).toBeUndefined();
    expect(review.sha256).toBe(sha256OfFile(file));
    expect(review.sha256).not.toBe(sha256(bytes.toString('utf8')));
    expect(review.dbRootId).toBe('db-root');
  });
});

describe('resolveDbRootForPath (containment)', () => {
  const roots: DbRootLite[] = [
    { id: 'db-a', path: '/ws/a' },
    { id: 'db-b', path: '/ws/b' },
  ];
  const identity = (p: string): string => p;

  it('resolves an exact root path to its DB id', () => {
    expect(resolveDbRootForPath('/ws/a', roots, identity)?.id).toBe('db-a');
  });

  it('resolves a nested path to its containing root', () => {
    expect(resolveDbRootForPath('/ws/b/nested/file', roots, identity)?.id).toBe('db-b');
  });

  it('returns null for a path outside every root', () => {
    expect(resolveDbRootForPath('/etc/passwd', roots, identity)).toBeNull();
  });

  it('does not match a sibling with a shared path prefix', () => {
    // `/ws/ab` must NOT be treated as inside `/ws/a`.
    expect(resolveDbRootForPath('/ws/ab', roots, identity)).toBeNull();
  });

  it('picks the most specific (longest) root for nested roots', () => {
    const nested: DbRootLite[] = [
      { id: 'outer', path: '/ws' },
      { id: 'inner', path: '/ws/a' },
    ];
    expect(resolveDbRootForPath('/ws/a/x', nested, identity)?.id).toBe('inner');
  });
});

describe('resolveTrustedRootIds', () => {
  const roots: DbRootLite[] = [{ id: 'db-a', path: '/ws/a' }];
  const resolve = (absPath: string): DbRootLite | null =>
    resolveDbRootForPath(absPath, roots, (p) => p);

  it('maps mounted paths to DB ids and drops unresolved paths', () => {
    const result = resolveTrustedRootIds(['/ws/a', '/ws/gone', 'relative'], resolve);
    expect(result).toEqual([{ dbRootId: 'db-a', path: '/ws/a' }]);
  });

  it('returns an empty list for a non-array input', () => {
    expect(resolveTrustedRootIds(undefined, resolve)).toEqual([]);
  });
});
