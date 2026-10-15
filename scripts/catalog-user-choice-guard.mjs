#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION_DIRECTORY = 'packages/db/src/migrations';
// Deliberately detect the assignment token without trying to infer its table
// from surrounding embedded SQL. A regex-based table parser could silently
// miss a model upsert; a future non-model match must instead be reviewed
// explicitly before this detector is narrowed.
const FORBIDDEN_ASSIGNMENT = /\bis_enabled\s*=\s*EXCLUDED\.is_enabled\b/gi;

// Entries here pin an exact amount of historical debt: fewer matches make the
// allowlist stale, while additional matches still fail the guard.
//
// EMPTY since the migration chain collapsed into one current-schema DDL
// (ADR-0020). The two entries this held -- migrations 026 and 028, which shipped
// catalog upserts written before the preservation invariant was documented --
// were deleted with the chain, so the debt they pinned no longer exists and the
// guard went stale on them (that is the guard working, and it is how this was
// found). The GUARD itself is deliberately kept and still scans
// packages/db/src/migrations, which now holds the generated current-schema DDL:
// that DDL seeds the catalog with plain INSERTs and no ON CONFLICT, so a future
// hand-edit introducing `is_enabled = EXCLUDED.is_enabled` would clobber the
// user's toggle (database.md rule 3) and must still fail here.
export const HISTORICAL_CATALOG_USER_CHOICE_ALLOWLIST = Object.freeze({});

function lineNumberAt(source, index) {
  return source.slice(0, index).split('\n').length;
}

/**
 * Find catalog upserts that overwrite the user's `models.is_enabled` choice
 * with a seed value. Allowlisted historical migrations are count-pinned so the
 * same files cannot silently accumulate more violations.
 */
export async function auditCatalogUserChoiceUpdates({
  allowedOccurrences = HISTORICAL_CATALOG_USER_CHOICE_ALLOWLIST,
  root = REPO_ROOT,
} = {}) {
  const migrationFiles = (
    await readdir(path.join(root, MIGRATION_DIRECTORY), {
      withFileTypes: true,
    })
  )
    .filter((entry) => entry.isFile() && /\.(?:ts|mts|cts)$/.test(entry.name))
    .map((entry) => `${MIGRATION_DIRECTORY}/${entry.name}`)
    .sort();

  const violations = [];
  const staleAllowlist = [];

  for (const filePath of migrationFiles) {
    const source = await readFile(path.join(root, filePath), 'utf8');
    const matches = [...source.matchAll(FORBIDDEN_ASSIGNMENT)].map((match) => ({
      filePath,
      lineNumber: lineNumberAt(source, match.index),
    }));
    const allowedCount = allowedOccurrences[filePath] ?? 0;

    if (matches.length < allowedCount) {
      staleAllowlist.push({ actualCount: matches.length, allowedCount, filePath });
      continue;
    }
    violations.push(...matches.slice(allowedCount));
  }

  for (const [filePath, allowedCount] of Object.entries(allowedOccurrences)) {
    if (!migrationFiles.includes(filePath)) {
      staleAllowlist.push({ actualCount: 0, allowedCount, filePath });
    }
  }

  return { staleAllowlist, violations };
}

async function main() {
  const result = await auditCatalogUserChoiceUpdates();
  if (result.violations.length === 0 && result.staleAllowlist.length === 0) {
    const allowedCount = Object.values(HISTORICAL_CATALOG_USER_CHOICE_ALLOWLIST).reduce(
      (total, count) => total + count,
      0
    );
    console.log(
      `No new catalog user-choice overwrites found; ${allowedCount} historical occurrences remain count-pinned under BST-667.`
    );
    return;
  }

  if (result.violations.length > 0) {
    console.error(
      'Potential model catalog user-choice overwrite found. Confirm each assignment belongs to models; model upserts must use models.is_enabled, not EXCLUDED.is_enabled:'
    );
    for (const violation of result.violations) {
      console.error(`- ${violation.filePath}:${violation.lineNumber}`);
    }
  }
  if (result.staleAllowlist.length > 0) {
    console.error('Historical catalog user-choice allowlist is stale:');
    for (const entry of result.staleAllowlist) {
      console.error(
        `- ${entry.filePath} (allowed ${entry.allowedCount}, found ${entry.actualCount})`
      );
    }
  }
  process.exitCode = 1;
}

const isDirectExecution =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  await main();
}
