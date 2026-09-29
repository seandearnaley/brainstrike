import { mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '@brainstrike/logging';
import type { DatabaseInitAttemptRecord, DatabaseInitPhaseReport } from '@brainstrike/types';
import { isDatabaseInitPhaseReport } from './db-host-protocol';
import { summarizeMalformedMessage } from './platform/summarize-malformed-message';
import { fsyncDirectory, isNoEntry, writeFileAtomically } from './write-file-atomically';

const logger = createLogger('DbInitAttemptRecord');

/**
 * Main's record of an init that timed out (BST-1883): `<profile>/.db-init-attempt.json`, a sibling
 * of `.db-clean-shutdown` and `.db-process.lock`. It lives INSIDE the profile directory so both
 * user-confirmed resets delete it with the profile, and only main reads or writes it: the host
 * never touches it. It is the loop breaker's memory across relaunches: two consecutive timeouts
 * in one phase stop main from forking a third host.
 */
const DB_INIT_ATTEMPT_FILENAME = '.db-init-attempt.json' as const;

/** Consecutive timeouts in one phase after which main stops forking hosts. */
export const DB_INIT_STOP_AFTER_TIMEOUTS = 2;

/** The phase a timeout is attributed to: the report's phase (per index for a rebuild), or before any. */
export function initPhaseKey(report: DatabaseInitPhaseReport | null): string {
  if (!report) {
    return 'init:first-report';
  }
  return report.phase === 'index-rebuild'
    ? `index-rebuild:${report.index.schema}.${report.index.index}`
    : report.phase;
}

/** The record after one more init timeout: the count grows only when the same phase expired again. */
export function nextInitTimeoutRecord(
  previous: DatabaseInitAttemptRecord | null,
  timeout: {
    readonly budgetMs: number;
    readonly hostPid: number | null;
    readonly now: Date;
    readonly report: DatabaseInitPhaseReport | null;
  }
): DatabaseInitAttemptRecord {
  const phaseKey = initPhaseKey(timeout.report);
  return {
    budgetMs: timeout.budgetMs,
    consecutiveTimeouts: previous?.phaseKey === phaseKey ? previous.consecutiveTimeouts + 1 : 1,
    hostPid: timeout.hostPid,
    lastTimeoutAt: timeout.now.toISOString(),
    phaseKey,
    report: timeout.report,
    version: 1,
  };
}

const PHASE_ACTIVITY: Readonly<Record<DatabaseInitPhaseReport['phase'], string>> = {
  'index-rebuild': 'rebuilding the search index',
  migration: 'applying database migrations',
  'open-database': 'opening the database and replaying its log',
};

/** What the phase that timed out was doing, in words a person can read. */
export function describeInitAttemptPhase(record: DatabaseInitAttemptRecord): string {
  return record.report ? PHASE_ACTIVITY[record.report.phase] : 'starting the database process';
}

export function isInitStopped(record: DatabaseInitAttemptRecord | null): boolean {
  return record !== null && record.consecutiveTimeouts >= DB_INIT_STOP_AFTER_TIMEOUTS;
}

function getRecordPath(profileDirectory: string): string {
  return path.join(profileDirectory, DB_INIT_ATTEMPT_FILENAME);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isAttemptRecord(value: unknown): value is DatabaseInitAttemptRecord {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate['version'] === 1 &&
    typeof candidate['phaseKey'] === 'string' &&
    candidate['phaseKey'].length > 0 &&
    (candidate['report'] === null || isDatabaseInitPhaseReport(candidate['report'])) &&
    isPositiveSafeInteger(candidate['budgetMs']) &&
    (candidate['hostPid'] === null || isPositiveSafeInteger(candidate['hostPid'])) &&
    isPositiveSafeInteger(candidate['consecutiveTimeouts']) &&
    typeof candidate['lastTimeoutAt'] === 'string'
  );
}

/**
 * The record, or null when there is none. Only an absent file reads as none without a log: a file
 * that is not valid JSON, has an unknown version or is malformed is logged at error and also reads
 * as none. That can only cost one more attempt, and it never deletes anything. A read failure of
 * any other kind (permissions, a directory at the path) throws.
 */
export function readDbInitAttemptRecord(
  profileDirectory: string
): DatabaseInitAttemptRecord | null {
  const recordPath = getRecordPath(profileDirectory);
  let contents: string;
  try {
    contents = readFileSync(recordPath, 'utf8');
  } catch (error) {
    if (isNoEntry(error)) {
      return null;
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    // Not the parse error itself: its message repeats a snippet of the file.
    logger.error('Ignoring a DB init attempt record that is not valid JSON', {
      byteLength: contents.length,
      recordPath,
    });
    return null;
  }
  if (!isAttemptRecord(parsed)) {
    logger.error('Ignoring a malformed or foreign-version DB init attempt record', {
      recordPath,
      ...summarizeMalformedMessage(parsed),
    });
    return null;
  }
  return parsed;
}

/**
 * Writes the record atomically. Creates the profile directory first: a timeout before the host's
 * first report can land before the host has created anything in a new profile.
 */
export function writeDbInitAttemptRecord(
  profileDirectory: string,
  record: DatabaseInitAttemptRecord
): void {
  mkdirSync(profileDirectory, { recursive: true });
  writeFileAtomically(
    getRecordPath(profileDirectory),
    JSON.stringify(record),
    'DB init attempt record'
  );
}

/** Removes the record, durably. An absent record is fine; any other failure throws. */
export function removeDbInitAttemptRecord(profileDirectory: string): void {
  try {
    unlinkSync(getRecordPath(profileDirectory));
  } catch (error) {
    if (isNoEntry(error)) {
      return;
    }
    throw error;
  }
  fsyncDirectory(profileDirectory);
}
