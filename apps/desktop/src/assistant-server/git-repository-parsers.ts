import path from 'node:path';
import type {
  GitBranchSummary,
  GitCommitFile,
  GitHistoryCommit,
  GitHistoryPage,
  GitWorktreeSummary,
} from '@brainstrike/types';

interface MutableWorktreeRecord {
  bare: boolean;
  branch: string | null;
  detached: boolean;
  head: string | null;
  lockedReason: string | null;
  path: string | null;
  prunableReason: string | null;
}

function createWorktreeRecord(): MutableWorktreeRecord {
  return {
    bare: false,
    branch: null,
    detached: false,
    head: null,
    lockedReason: null,
    path: null,
    prunableReason: null,
  };
}

function finishWorktreeRecord(
  record: MutableWorktreeRecord,
  currentWorktreePath: string
): GitWorktreeSummary | null {
  if (record.path === null) {
    return null;
  }
  const worktreePath = path.resolve(record.path);
  return {
    bare: record.bare,
    branch: record.branch,
    current: worktreePath === path.resolve(currentWorktreePath),
    detached: record.detached,
    head: record.head,
    lockedReason: record.lockedReason,
    name: path.basename(worktreePath),
    path: worktreePath,
    prunableReason: record.prunableReason,
  };
}

function applyWorktreeField(record: MutableWorktreeRecord, field: string): void {
  if (field.startsWith('worktree ')) {
    record.path = field.slice('worktree '.length);
    return;
  }
  if (field.startsWith('HEAD ')) {
    record.head = field.slice('HEAD '.length);
    return;
  }
  if (field.startsWith('branch refs/heads/')) {
    record.branch = field.slice('branch refs/heads/'.length);
    return;
  }
  if (field === 'detached') {
    record.detached = true;
    return;
  }
  if (field === 'bare') {
    record.bare = true;
    return;
  }
  if (field === 'locked' || field.startsWith('locked ')) {
    record.lockedReason = field.slice('locked'.length).trim();
    return;
  }
  if (field === 'prunable' || field.startsWith('prunable ')) {
    record.prunableReason = field.slice('prunable'.length).trim();
    return;
  }
  throw new Error(`git returned an unsupported worktree field "${field}"`);
}

/** Parse the stable `git worktree list --porcelain -z` format. */
export function parseWorktreeSummaries(
  stdout: string,
  currentWorktreePath: string
): readonly GitWorktreeSummary[] {
  const worktrees: GitWorktreeSummary[] = [];
  let record = createWorktreeRecord();

  for (const field of stdout.split('\0')) {
    if (field.length === 0) {
      const finished = finishWorktreeRecord(record, currentWorktreePath);
      if (finished) {
        worktrees.push(finished);
      }
      record = createWorktreeRecord();
      continue;
    }
    applyWorktreeField(record, field);
  }

  if (worktrees.length === 0) {
    throw new Error('git returned no parseable worktrees');
  }
  return worktrees;
}

/** Parse NUL-separated `for-each-ref` fields (four fields per local branch). */
export function parseBranchSummaries(stdout: string): readonly GitBranchSummary[] {
  const fields = stdout.split('\0');
  const branches: GitBranchSummary[] = [];
  let index = 0;
  while (index + 3 < fields.length) {
    const rawName = fields[index] ?? '';
    const name = rawName.replace(/^\n/, '');
    const head = fields[index + 1] ?? '';
    const currentMarker = fields[index + 2] ?? '';
    const upstream = fields[index + 3] ?? '';
    index += 4;

    if (name.length === 0) {
      throw new Error('git returned a branch with no name');
    }
    if (!/^[0-9a-f]{40,64}$/.test(head)) {
      throw new Error(`git returned an invalid object id for branch "${name}"`);
    }
    branches.push({
      current: currentMarker === '*',
      head,
      name,
      upstream: upstream.length > 0 ? upstream : null,
      worktreePath: null,
    });
  }

  const remainder = fields.slice(index).join('').trim();
  if (remainder.length > 0) {
    throw new Error('git returned malformed branch metadata');
  }
  return branches;
}

const HISTORY_FIELD_COUNT = 10;

/** Parse fixed-width NUL fields from `git log -z --format=...`. */
export function parseHistoryPage(
  stdout: string,
  options: { readonly limit: number; readonly offset: number }
): GitHistoryPage {
  const fields = stdout.split('\0');
  if (fields.at(-1) === '') {
    fields.pop();
  }
  if (fields.length % HISTORY_FIELD_COUNT !== 0) {
    throw new Error('git returned malformed commit history metadata');
  }

  const parsed: GitHistoryCommit[] = [];
  for (let index = 0; index < fields.length; index += HISTORY_FIELD_COUNT) {
    const id = fields[index] ?? '';
    const shortId = fields[index + 1] ?? '';
    if (!(/^[0-9a-f]{40,64}$/.test(id) && /^[0-9a-f]+$/.test(shortId))) {
      throw new Error('git returned an invalid commit object id');
    }
    parsed.push({
      authorEmail: fields[index + 5] ?? '',
      authoredAt: fields[index + 6] ?? '',
      authorName: fields[index + 4] ?? '',
      body: (fields[index + 3] ?? '').trim(),
      committedAt: fields[index + 7] ?? '',
      decoration: fields[index + 9] ?? '',
      id,
      parentIds: (fields[index + 8] ?? '').split(' ').filter(Boolean),
      shortId,
      summary: fields[index + 2] ?? '',
    });
  }

  return {
    commits: parsed.slice(0, options.limit),
    hasMore: parsed.length > options.limit,
    limit: options.limit,
    offset: options.offset,
  };
}

/** Parse `git diff-tree --name-status -z`, including rename/copy old+new paths. */
export function parseCommitFiles(stdout: string): readonly GitCommitFile[] {
  const fields = stdout.split('\0');
  if (fields.at(-1) === '') {
    fields.pop();
  }
  const files: GitCommitFile[] = [];
  let index = 0;
  while (index < fields.length) {
    const rawStatus = fields[index] ?? '';
    index += 1;
    const status = rawStatus[0] ?? '';
    if (!/^[ACDMRTUXB]$/.test(status)) {
      throw new Error(`git returned an invalid commit file status "${rawStatus}"`);
    }
    if (status === 'R' || status === 'C') {
      const originalPath = fields[index] ?? '';
      const filePath = fields[index + 1] ?? '';
      index += 2;
      if (!(originalPath && filePath)) {
        throw new Error('git returned malformed rename metadata');
      }
      files.push({ originalPath, path: filePath, status });
      continue;
    }
    const filePath = fields[index] ?? '';
    index += 1;
    if (!filePath) {
      throw new Error('git returned a commit file with no path');
    }
    files.push({ path: filePath, status });
  }
  return files;
}
