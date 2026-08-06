/**
 * Pure-logic coverage for `snapshot-restore-plan.ts` (W7 T0, BST-1164): the
 * `git diff --raw -z` / `git ls-tree -r -z` parsers, restore-plan computation
 * (target→preRevert direction), and the empty-ancestor directory pruner
 * (ported from the BST-1115 journal-revert pruner — root-boundary semantics
 * preserved). No git is spawned anywhere in this file; the pruner tests use
 * real tmp directories only.
 *
 * MUTATION VERIFICATION (performed manually; each mutation was applied,
 * confirmed to fail exactly the named test, then reverted):
 * - Pruner root boundary: removing the `current !== canonicalRootPath`
 *   conjunct in `pruneEmptyAncestorDirectories` fails
 *   "stops unconditionally at the root" (the root itself is rmdir'd).
 * - Plan A→delete mapping: mapping status 'A' to a restore action instead of
 *   `delete-file` fails "maps added-in-range entries to delete-file actions".
 * - Gitlink guard: dropping the `oldMode === '160000'` nested-repo branch
 *   fails "routes gitlink entries to nested-repo actions, never
 *   restore/delete".
 */
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computeRestorePlanActions,
  parseLsTreeZ,
  parseRawDiffZ,
  pruneEmptyAncestorDirectories,
  type RawDiffEntry,
  RestorePlanError,
} from '../../assistant-server/snapshot-restore-plan';

const ZERO_OID = '0'.repeat(40);
const OID_A = 'a'.repeat(40);
const OID_B = 'b'.repeat(40);

function rawRecord(
  oldMode: string,
  newMode: string,
  oldOid: string,
  newOid: string,
  status: string,
  filePath: string
): string {
  return `:${oldMode} ${newMode} ${oldOid} ${newOid} ${status}\0${filePath}\0`;
}

describe('parseRawDiffZ', () => {
  it('parses added, modified, deleted, and typechange records', () => {
    const stdout =
      rawRecord('000000', '100644', ZERO_OID, OID_A, 'A', 'new.txt') +
      rawRecord('100644', '100755', OID_A, OID_B, 'M', 'dir/mod.txt') +
      rawRecord('100644', '000000', OID_A, ZERO_OID, 'D', 'gone.txt') +
      rawRecord('100644', '120000', OID_A, OID_B, 'T', 'became-link');
    const entries = parseRawDiffZ(stdout);
    expect(entries).toEqual([
      {
        newMode: '100644',
        newOid: OID_A,
        oldMode: '000000',
        oldOid: ZERO_OID,
        path: 'new.txt',
        status: 'A',
      },
      {
        newMode: '100755',
        newOid: OID_B,
        oldMode: '100644',
        oldOid: OID_A,
        path: 'dir/mod.txt',
        status: 'M',
      },
      {
        newMode: '000000',
        newOid: ZERO_OID,
        oldMode: '100644',
        oldOid: OID_A,
        path: 'gone.txt',
        status: 'D',
      },
      {
        newMode: '120000',
        newOid: OID_B,
        oldMode: '100644',
        oldOid: OID_A,
        path: 'became-link',
        status: 'T',
      },
    ]);
  });

  it('parses an empty diff to an empty list', () => {
    expect(parseRawDiffZ('')).toEqual([]);
  });

  it('preserves paths containing spaces and tabs verbatim', () => {
    const entries = parseRawDiffZ(
      rawRecord('000000', '100644', ZERO_OID, OID_A, 'A', 'has space\tand tab.txt')
    );
    expect(entries[0]?.path).toBe('has space\tand tab.txt');
  });

  it('throws on a rename/copy record (the engine always diffs --no-renames)', () => {
    const stdout = `:100644 100644 ${OID_A} ${OID_B} R100\0old.txt\0new.txt\0`;
    expect(() => parseRawDiffZ(stdout)).toThrow(RestorePlanError);
  });

  it('throws on a malformed header instead of skipping it', () => {
    expect(() => parseRawDiffZ('garbage\0path\0')).toThrow(RestorePlanError);
  });

  it('throws on a header with a missing path field', () => {
    expect(() => parseRawDiffZ(`:100644 100644 ${OID_A} ${OID_B} M\0`)).toThrow(RestorePlanError);
  });
});

describe('parseLsTreeZ', () => {
  it('parses blob, commit (gitlink), and symlink entries', () => {
    const stdout =
      `100644 blob ${OID_A}\ta.txt\0` +
      `120000 blob ${OID_B}\tlink.txt\0` +
      `160000 commit ${OID_A}\tnested\0`;
    expect(parseLsTreeZ(stdout)).toEqual([
      { mode: '100644', oid: OID_A, path: 'a.txt', type: 'blob' },
      { mode: '120000', oid: OID_B, path: 'link.txt', type: 'blob' },
      { mode: '160000', oid: OID_A, path: 'nested', type: 'commit' },
    ]);
  });

  it('parses empty output to an empty list and throws on malformed records', () => {
    expect(parseLsTreeZ('')).toEqual([]);
    expect(() => parseLsTreeZ('not-a-record\0')).toThrow(RestorePlanError);
  });
});

describe('computeRestorePlanActions', () => {
  function entry(overrides: Partial<RawDiffEntry> & Pick<RawDiffEntry, 'path' | 'status'>) {
    return {
      newMode: '100644',
      newOid: OID_B,
      oldMode: '100644',
      oldOid: OID_A,
      ...overrides,
    };
  }

  it('maps added-in-range entries to delete-file actions', () => {
    const actions = computeRestorePlanActions([
      entry({ newOid: OID_A, oldMode: '000000', oldOid: ZERO_OID, path: 'added.txt', status: 'A' }),
    ]);
    expect(actions).toEqual([{ kind: 'delete-file', path: 'added.txt' }]);
  });

  it('maps modified and deleted-in-range entries to content restores from the target side', () => {
    const actions = computeRestorePlanActions([
      entry({ path: 'mod.txt', status: 'M' }),
      entry({ newMode: '000000', newOid: ZERO_OID, path: 'gone.txt', status: 'D' }),
      entry({ oldMode: '100755', path: 'tool.sh', status: 'M' }),
    ]);
    expect(actions).toEqual([
      { executable: false, kind: 'restore-file', path: 'mod.txt', targetBlobOid: OID_A },
      { executable: false, kind: 'restore-file', path: 'gone.txt', targetBlobOid: OID_A },
      { executable: true, kind: 'restore-file', path: 'tool.sh', targetBlobOid: OID_A },
    ]);
  });

  it('maps a symlink target side to restore-symlink (typechange included)', () => {
    const actions = computeRestorePlanActions([
      entry({ oldMode: '120000', path: 'link.txt', status: 'M' }),
      entry({ newMode: '100644', oldMode: '120000', path: 'was-link', status: 'T' }),
    ]);
    expect(actions).toEqual([
      { kind: 'restore-symlink', path: 'link.txt', targetBlobOid: OID_A },
      { kind: 'restore-symlink', path: 'was-link', targetBlobOid: OID_A },
    ]);
  });

  it('routes gitlink entries to nested-repo actions, never restore/delete', () => {
    const actions = computeRestorePlanActions([
      // Nested repo existed at target, changed commit in range.
      entry({ newMode: '160000', oldMode: '160000', path: 'nested-mod', status: 'M' }),
      // Nested repo added in range: deleting it would rm -rf a repository.
      entry({
        newMode: '160000',
        oldMode: '000000',
        oldOid: ZERO_OID,
        path: 'nested-added',
        status: 'A',
      }),
      // Nested repo removed in range: cannot be recreated from a gitlink.
      entry({
        newMode: '000000',
        newOid: ZERO_OID,
        oldMode: '160000',
        path: 'nested-gone',
        status: 'D',
      }),
      // File became a nested repo in range: touching it would touch a repo.
      entry({ newMode: '160000', path: 'file-became-repo', status: 'T' }),
    ]);
    expect(actions).toEqual([
      { kind: 'nested-repo', path: 'nested-mod' },
      { kind: 'nested-repo', path: 'nested-gone' },
      { kind: 'nested-repo', path: 'file-became-repo' },
      { kind: 'nested-repo', path: 'nested-added' },
    ]);
  });

  it('orders every restore before any delete (deletes prune dirs restores may need)', () => {
    const actions = computeRestorePlanActions([
      entry({ oldMode: '000000', oldOid: ZERO_OID, path: 'added-1.txt', status: 'A' }),
      entry({ path: 'mod.txt', status: 'M' }),
      entry({ oldMode: '000000', oldOid: ZERO_OID, path: 'added-2.txt', status: 'A' }),
    ]);
    expect(actions.map((action) => action.kind)).toEqual([
      'restore-file',
      'delete-file',
      'delete-file',
    ]);
    expect(actions.map((action) => action.path)).toEqual(['mod.txt', 'added-1.txt', 'added-2.txt']);
  });

  it('rejects absolute and root-escaping paths', () => {
    expect(() => computeRestorePlanActions([entry({ path: '/etc/passwd', status: 'M' })])).toThrow(
      RestorePlanError
    );
    expect(() =>
      computeRestorePlanActions([entry({ path: '../outside.txt', status: 'M' })])
    ).toThrow(RestorePlanError);
    expect(() => computeRestorePlanActions([entry({ path: 'a/../../b', status: 'M' })])).toThrow(
      RestorePlanError
    );
  });

  it('throws on an unsupported status or mode instead of skipping the entry', () => {
    expect(() => computeRestorePlanActions([entry({ path: 'x', status: 'U' })])).toThrow(
      RestorePlanError
    );
    expect(() =>
      computeRestorePlanActions([entry({ oldMode: '040000', path: 'y', status: 'M' })])
    ).toThrow(RestorePlanError);
  });
});

describe('pruneEmptyAncestorDirectories', () => {
  const createdRoots: string[] = [];

  async function makeRoot(): Promise<string> {
    const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-snap-prune-'));
    const real = await fsPromises.realpath(root);
    createdRoots.push(real);
    return real;
  }

  afterEach(async () => {
    while (createdRoots.length > 0) {
      const root = createdRoots.pop();
      if (root) {
        await fsPromises.rm(root, { force: true, recursive: true });
      }
    }
  });

  it('removes now-empty ancestors up to (but never including) the root', async () => {
    const root = await makeRoot();
    const deep = path.join(root, 'a', 'b', 'c');
    await fsPromises.mkdir(deep, { recursive: true });

    await pruneEmptyAncestorDirectories(root, deep);

    await expect(fsPromises.stat(path.join(root, 'a'))).rejects.toMatchObject({ code: 'ENOENT' });
    // The root itself survives — this is the boundary, not a candidate.
    expect((await fsPromises.stat(root)).isDirectory()).toBe(true);
  });

  it('stops unconditionally at the root even when the walk starts AT the root', async () => {
    const root = await makeRoot();
    await pruneEmptyAncestorDirectories(root, root);
    expect((await fsPromises.stat(root)).isDirectory()).toBe(true);
  });

  it('stops at the first non-empty directory', async () => {
    const root = await makeRoot();
    const deep = path.join(root, 'a', 'b', 'c');
    await fsPromises.mkdir(deep, { recursive: true });
    await fsPromises.writeFile(path.join(root, 'a', 'keep.txt'), 'keep', 'utf8');

    await pruneEmptyAncestorDirectories(root, deep);

    await expect(fsPromises.stat(deep)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fsPromises.stat(path.join(root, 'a'))).isDirectory()).toBe(true);
    expect(await fsPromises.readFile(path.join(root, 'a', 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('never removes a directory outside the root', async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    const outsideChild = path.join(outside, 'child');
    await fsPromises.mkdir(outsideChild);

    await pruneEmptyAncestorDirectories(root, outsideChild);

    expect((await fsPromises.stat(outsideChild)).isDirectory()).toBe(true);
  });
});
