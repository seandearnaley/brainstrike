// SPIKE (BST-1110) — throwaway reference. Known shortcuts + caveats recorded in ../RECOMMENDATION.md; do not port verbatim.
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { runGit } from './git.ts';

const CONTENT_CAP_BYTES = 2 * 1024 * 1024; // provisional; Q3 tunes this

export type DiffScope = 'uncommitted' | 'staged' | 'branch-vs-base';

export interface FileDiffEntry {
  additions: number | null;
  binary: boolean;
  deletions: number | null;
  newContent: string | null;
  oldContent: string | null;
  overCap: boolean;
  path: string;
  status: 'A' | 'M' | 'D' | 'R' | 'U';
}

export interface ScopeDiff {
  base: string | null;
  files: FileDiffEntry[];
  scope: string;
  timingMs: { list: number; content: number; total: number };
  worktreePath: string;
}

function parseNumstat(
  zOutput: string
): Map<string, { additions: number | null; deletions: number | null }> {
  const out = new Map<string, { additions: number | null; deletions: number | null }>();
  const fields = zOutput.split('\0').filter(Boolean);
  // numstat -z: "adds\tdels\tpath" per record; renames emit "adds\tdels\t" then oldPath then newPath
  for (let i = 0; i < fields.length; i += 1) {
    const record = fields[i];
    if (record === undefined) {
      throw new Error(`unparseable numstat record at index ${i}`);
    }
    const [adds, dels, inlinePath] = record.split('\t');
    let path = inlinePath;
    if (inlinePath === '') {
      i += 2; // skip oldPath, take newPath
      path = fields[i];
    }
    if (path === undefined || adds === undefined || dels === undefined) {
      throw new Error(`unparseable numstat record: ${record}`);
    }
    out.set(path, {
      additions: adds === '-' ? null : Number(adds),
      deletions: dels === '-' ? null : Number(dels),
    });
  }
  return out;
}

async function readSide(
  worktreePath: string,
  ref: string | 'worktree',
  path: string
): Promise<{ content: string | null; binary: boolean; overCap: boolean }> {
  try {
    const buffer =
      ref === 'worktree'
        ? await readFile(join(worktreePath, path))
        : Buffer.from(await runGit(worktreePath, ['cat-file', 'blob', `${ref}:${path}`]), 'utf8');
    if (buffer.length > CONTENT_CAP_BYTES) {
      return { binary: false, content: null, overCap: true };
    }
    if (buffer.includes(0)) {
      return { binary: true, content: null, overCap: false };
    }
    return { binary: false, content: buffer.toString('utf8'), overCap: false };
  } catch {
    return { binary: false, content: null, overCap: false }; // absent side (added/deleted)
  }
}

export async function computeScopeDiff(worktreePath: string, scope: DiffScope): Promise<ScopeDiff> {
  const t0 = performance.now();
  let base: string | null = null;
  let listArgs: string[];
  let oldRef: string;
  let newRef: string | 'worktree';

  if (scope === 'uncommitted') {
    listArgs = ['diff', 'HEAD', '--numstat', '-z', '--find-renames'];
    oldRef = 'HEAD';
    newRef = 'worktree';
  } else if (scope === 'staged') {
    listArgs = ['diff', '--cached', '--numstat', '-z', '--find-renames'];
    oldRef = 'HEAD';
    newRef = ''; // index — read via cat-file with :0:path
  } else {
    const upstream = (
      await runGit(worktreePath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
    ).trim();
    base = (await runGit(worktreePath, ['merge-base', 'HEAD', upstream])).trim();
    listArgs = ['diff', `${base}...HEAD`, '--numstat', '-z', '--find-renames'];
    oldRef = base;
    newRef = 'HEAD';
  }

  const numstat = parseNumstat(await runGit(worktreePath, listArgs));
  const statusZ = await runGit(worktreePath, [
    'status',
    '--porcelain=v2',
    '-z',
    '--untracked-files=all',
  ]);
  const untracked = statusZ
    .split('\0')
    .filter((l) => l.startsWith('? '))
    .map((l) => l.slice(2));
  const t1 = performance.now();

  const files: FileDiffEntry[] = [];
  for (const [path, counts] of numstat) {
    const old = await readSide(worktreePath, oldRef, path);
    const now =
      scope === 'staged'
        ? await readSide(worktreePath, ':0', path)
        : await readSide(worktreePath, newRef, path);
    const status: FileDiffEntry['status'] =
      old.content === null && !old.binary && !old.overCap
        ? 'A'
        : now.content === null && !now.binary && !now.overCap
          ? 'D'
          : 'M';
    files.push({
      additions: counts.additions,
      binary: old.binary || now.binary,
      deletions: counts.deletions,
      newContent: now.content,
      oldContent: old.content,
      overCap: old.overCap || now.overCap,
      path,
      status,
    });
  }
  if (scope === 'uncommitted') {
    for (const path of untracked) {
      const now = await readSide(worktreePath, 'worktree', path);
      files.push({
        additions: now.content?.split('\n').length ?? null,
        binary: now.binary,
        deletions: 0,
        newContent: now.content,
        oldContent: null,
        overCap: now.overCap,
        path,
        status: 'U',
      });
    }
  }
  const t2 = performance.now();
  return {
    base,
    files,
    scope,
    timingMs: { content: t2 - t1, list: t1 - t0, total: t2 - t0 },
    worktreePath,
  };
}

const isDirectCliInvocation =
  process.argv[1] !== undefined &&
  resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

if (isDirectCliInvocation) {
  const [worktreePath, scope] = process.argv.slice(2);
  if (!(worktreePath && ['uncommitted', 'staged', 'branch-vs-base'].includes(scope ?? ''))) {
    // biome-ignore lint/suspicious/noConsole: CLI entry point diagnostic output
    console.error(
      'usage: node src/scope-diff.ts <worktreePath> <uncommitted|staged|branch-vs-base>'
    );
    process.exit(1);
  }
  const diff = await computeScopeDiff(worktreePath, scope as DiffScope);
  // biome-ignore lint/suspicious/noConsole: CLI entry point diagnostic output
  console.log(
    JSON.stringify(
      {
        ...diff,
        files: diff.files.map((f) => ({
          ...f,
          newContent: f.newContent ? `${f.newContent.length}B` : null,
          oldContent: f.oldContent ? `${f.oldContent.length}B` : null,
        })),
      },
      null,
      2
    )
  );
  // biome-ignore lint/suspicious/noConsole: CLI entry point diagnostic output
  console.error(
    `files=${diff.files.length} list=${diff.timingMs.list.toFixed(0)}ms content=${diff.timingMs.content.toFixed(0)}ms`
  );
}
