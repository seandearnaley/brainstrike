// @ts-check
import { readChecks, rollupForgeChecks } from '@brainstrike/types';

const worktreeColumns = `id, repo_common_dir AS repoCommonDir, path, branch, base_ref AS baseRef,
  created_by AS createdBy, thread_id AS threadId, run_id AS runId, setup_status AS setupStatus,
  setup_output AS setupOutput, setup_reason AS setupReason, created_at AS createdAt,
  archived_at AS archivedAt, archive_snapshot_ref AS archiveSnapshotRef`;

/** @param {import('better-sqlite3').Database} db
 * @param {import('./worktree-forge-types.js').WorktreeLedgerRequest} request
 * @returns {import('./worktree-forge-types.js').WorktreeLedgerReply} */
export function executeWorktreeLedgerRequest(db, request) {
  const table = 'brainstrike_worktrees';
  const read = `SELECT ${worktreeColumns} FROM ${table}`;
  /** @type {unknown[]} */ let rows;
  switch (request.operation) {
    case 'get':
      rows = db.prepare(`${read} WHERE id=?`).all(request.id);
      break;
    case 'by-path':
      rows = db.prepare(`${read} WHERE path=?`).all(request.path);
      break;
    case 'list-active':
      rows = db.prepare(`${read} WHERE archived_at IS NULL ORDER BY created_at DESC,id DESC`).all();
      break;
    case 'list-repository':
      rows = db
        .prepare(`${read} WHERE repo_common_dir=? ORDER BY created_at DESC,id DESC`)
        .all(request.repoCommonDir);
      break;
    case 'insert': {
      const row = request.row;
      rows = db
        .prepare(`INSERT INTO ${table} (id,repo_common_dir,path,branch,base_ref,created_by,
        thread_id,run_id,setup_status,setup_output,setup_reason,created_at,archived_at,archive_snapshot_ref)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL) RETURNING ${worktreeColumns}`)
        .all(
          row.id,
          row.repoCommonDir,
          row.path,
          row.branch,
          row.baseRef,
          row.createdBy,
          row.threadId,
          row.runId,
          row.setupStatus,
          row.setupOutput,
          row.setupReason,
          new Date(row.createdAt).toISOString()
        );
      break;
    }
    case 'archive':
      rows = db
        .prepare(
          `UPDATE ${table} SET archived_at=?,archive_snapshot_ref=? WHERE id=? RETURNING ${worktreeColumns}`
        )
        .all(new Date().toISOString(), request.snapshotRef, request.id);
      break;
    case 'restore':
      rows = db
        .prepare(
          `UPDATE ${table} SET archived_at=NULL,archive_snapshot_ref=NULL WHERE id=? RETURNING ${worktreeColumns}`
        )
        .all(request.id);
      break;
    case 'setup':
      rows = db
        .prepare(
          `UPDATE ${table} SET setup_status=?,setup_output=?,setup_reason=? WHERE id=? RETURNING ${worktreeColumns}`
        )
        .all(request.status, request.output, request.reason, request.id);
      break;
    case 'branch':
      rows = db
        .prepare(`UPDATE ${table} SET branch=? WHERE id=? RETURNING ${worktreeColumns}`)
        .all(request.branch, request.id);
      break;
    default:
      throw new Error('Unknown worktree ledger operation');
  }
  if (['archive', 'restore', 'setup', 'branch'].includes(request.operation) && rows.length !== 1) {
    throw new Error('Managed worktree mutation matched no ledger row');
  }
  return {
    rows: /** @type {import('./worktree-forge-types.js').WorktreeLedgerReply['rows']} */ (rows),
  };
}

/** @param {unknown} value @param {string} field @returns {string} */
function text(value, field) {
  if (typeof value !== 'string') {
    throw new Error(`Cached forge PR has unreadable ${field}`);
  }
  return value;
}
/** @param {unknown} value @returns {boolean} */
function sqliteBoolean(value) {
  if (value !== 0 && value !== 1) {
    throw new Error('Cached forge PR has invalid SQLite boolean');
  }
  return value === 1;
}
/** @param {unknown} value @returns {import('./worktree-forge-types.js').ForgeCacheEntry | null} */
function readEntry(value) {
  if (value === undefined) {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Cached forge PR row is malformed');
  }
  const row = /** @type {Record<string,unknown>} */ (value);
  const observedAt = new Date(text(row['observedAt'], 'observation timestamp')).toISOString();
  if (row['number'] === null) {
    if (
      ['url', 'title', 'state', 'isDraft', 'reviewDecision', 'checksJson', 'headSha'].some(
        (field) => row[field] !== null
      )
    ) {
      throw new Error('Cached absent forge PR contains PR fields');
    }
    return { observedAt, pullRequest: null };
  }
  const number = row['number'];
  if (typeof number !== 'number' || !Number.isInteger(number)) {
    throw new Error('Cached forge PR number is invalid');
  }
  const state = row['state'];
  if (state !== 'open' && state !== 'closed' && state !== 'merged') {
    throw new Error('Cached forge PR state is invalid');
  }
  const reviewDecision = row['reviewDecision'];
  if (
    reviewDecision !== null &&
    reviewDecision !== 'APPROVED' &&
    reviewDecision !== 'CHANGES_REQUESTED' &&
    reviewDecision !== 'REVIEW_REQUIRED'
  ) {
    throw new Error('Cached forge PR review decision is invalid');
  }
  const headSha = text(row['headSha'], 'head SHA');
  const url = text(row['url'], 'URL');
  if (!(headSha && url)) {
    throw new Error('Cached forge PR identity is empty');
  }
  const checks = readChecks(row['checksJson']);
  return {
    observedAt,
    pullRequest: {
      checks,
      checksRollup: rollupForgeChecks(checks),
      headSha,
      isDraft: sqliteBoolean(row['isDraft']),
      number,
      reviewDecision,
      state,
      title: text(row['title'], 'title'),
      url,
    },
  };
}
/** @param {import('better-sqlite3').Database} db
 * @param {import('./worktree-forge-types.js').ForgeCacheRequest} request
 * @returns {import('./worktree-forge-types.js').ForgeCacheReply} */
export function executeForgeCacheRequest(db, request) {
  if (request.operation === 'write') {
    writeEntry(db, request);
  } else if (request.operation !== 'get') {
    throw new Error('Unknown Forge cache operation');
  }
  const row = db
    .prepare(`SELECT number,url,title,state,is_draft AS isDraft,review_decision AS reviewDecision,
    checks_json AS checksJson,head_sha AS headSha,observed_at AS observedAt FROM brainstrike_forge_prs
    WHERE repo_common_dir=? AND branch=?`)
    .get(request.repoCommonDir, request.branch);
  return { entry: readEntry(row) };
}

/** @param {import('better-sqlite3').Database} db
 * @param {Extract<import('./worktree-forge-types.js').ForgeCacheRequest, {operation:'write'}>} request */
function writeEntry(db, request) {
  const pr = request.pullRequest;
  validateEntry(pr, request.observedAt);
  db.prepare(`INSERT INTO brainstrike_forge_prs
      (repo_common_dir,branch,number,url,title,state,is_draft,review_decision,checks_json,head_sha,observed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(repo_common_dir,branch) DO UPDATE SET
      number=excluded.number,url=excluded.url,title=excluded.title,state=excluded.state,is_draft=excluded.is_draft,
      review_decision=excluded.review_decision,checks_json=excluded.checks_json,head_sha=excluded.head_sha,observed_at=excluded.observed_at`).run(
    request.repoCommonDir,
    request.branch,
    pr?.number ?? null,
    pr?.url ?? null,
    pr?.title ?? null,
    pr?.state ?? null,
    pr ? Number(pr.isDraft) : null,
    pr?.reviewDecision ?? null,
    pr ? JSON.stringify(readChecks(pr.checks)) : null,
    pr?.headSha ?? null,
    new Date(request.observedAt).toISOString()
  );
}

/** @param {import('./worktree-forge-types.js').ForgeCacheEntry['pullRequest']} pr
 * @param {string} observedAt */
function validateEntry(pr, observedAt) {
  if (pr !== null && typeof pr?.isDraft !== 'boolean') {
    throw new Error('Forge draft must be a boolean');
  }
  readEntry({
    checksJson: pr ? pr.checks : null,
    headSha: pr?.headSha ?? null,
    isDraft: pr ? Number(pr.isDraft) : null,
    number: pr?.number ?? null,
    observedAt,
    reviewDecision: pr?.reviewDecision ?? null,
    state: pr?.state ?? null,
    title: pr?.title ?? null,
    url: pr?.url ?? null,
  });
}

/** @param {import('better-sqlite3').Database} db
 * @returns {readonly import('@brainstrike/types').ForgePrCacheEntry[]} */
export function readForgeCacheSnapshot(db) {
  const rows = /** @type {Record<string,unknown>[]} */ (
    db
      .prepare(`SELECT repo_common_dir AS repoCommonDir,branch,number,url,title,state,
    is_draft AS isDraft,review_decision AS reviewDecision,checks_json AS checksJson,head_sha AS headSha,observed_at AS observedAt
    FROM brainstrike_forge_prs ORDER BY repo_common_dir,branch`)
      .all()
  );
  return rows.flatMap((row) => {
    const entry = readEntry(row);
    if (!entry?.pullRequest) {
      return [];
    }
    const pr = entry.pullRequest;
    return [
      {
        branch: text(row['branch'], 'branch'),
        checksRollup: pr.checksRollup,
        isDraft: pr.isDraft,
        number: pr.number,
        repoCommonDir: text(row['repoCommonDir'], 'repository'),
        state: pr.state,
        url: pr.url,
      },
    ];
  });
}
