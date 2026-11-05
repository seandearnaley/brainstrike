/**
 * Git and worktree failures in the one boundary failure shape (BST-2383).
 *
 * Git's own words reach the user as a refusal they can act on (a hook's
 * output, a rejected push). A cause git never reported, such as a runner that
 * threw, is a fault: it stays in this log under the correlation id the user
 * sees.
 */
import { randomUUID } from 'node:crypto';
import {
  type BoundaryFailure,
  type BoundaryFailureCategory,
  BoundaryFailureError,
  fault,
  refusal,
} from '@brainstrike/assistant-contract/boundary-failure';
import { createLogger } from '@brainstrike/logging';
import type { GitCommandRun } from './git-service.ts';

const logger = createLogger('GitFailure');

export interface GitFailed {
  readonly error: BoundaryFailure;
  readonly ok: false;
}

function failed(error: BoundaryFailure): GitFailed {
  return { error, ok: false };
}

/** Declined for a reason the user or model can act on. */
export function gitRefused(
  category: BoundaryFailureCategory,
  code: string,
  message: string,
  remedy?: string
): GitFailed {
  return failed(refusal({ category, code, message, ...(remedy === undefined ? {} : { remedy }) }));
}

/** The request named something git cannot act on: an empty branch, a bad path. */
export function gitInvalid(message: string): GitFailed {
  return gitRefused('input', 'git.invalid-request', message);
}

/** A changes view does not offer the action, or its target cannot take it. */
export function refuseUnoffered(message: string): GitFailed {
  return gitRefused('input', 'changeset.action-unavailable', message);
}

/** A changes target is no longer what the view drew. */
export function refuseStale(message: string): GitFailed {
  return gitRefused('conflict', 'changeset.stale', message);
}

/** A path that resolves outside the folder the user opened. */
export function gitOutsideFolder(message: string): GitFailed {
  return gitRefused('authorization', 'git.outside-folder', message);
}

/** An operation that failed partway; its message says what the user still has. */
export function gitFault(code: string, message: string): GitFailed {
  return failed(fault({ category: 'internal', code, message }));
}

/** Git, or a repository's own metadata, answered in a shape this service cannot read. */
export function gitUnexpected(message: string): GitFailed {
  return failed(fault({ category: 'internal', code: 'git.unexpected-output', message }));
}

/**
 * A throw on the way to git. A typed failure keeps its type; any other cause
 * is logged here and never travels.
 */
export function gitThrew(cause: unknown): GitFailed {
  if (cause instanceof BoundaryFailureError) {
    return failed(cause.failure);
  }
  const correlationId = randomUUID();
  logger.error('Git operation threw', { cause, correlationId });
  return failed(
    fault({
      category: 'internal',
      code: 'git.internal',
      correlationId,
      message: 'The git operation failed unexpectedly.',
    })
  );
}

/** True when a failed `git` run was a "not a repository" fatal (exit 128). */
export function isNotARepository(run: GitCommandRun): boolean {
  return /not a git repository/iu.test(run.stderr);
}

const AUTHENTICATION_FAILED =
  /authentication failed|could not read (?:username|password)|permission denied \(publickey|terminal prompts disabled/iu;
const PUSH_REJECTED = /\[rejected\]|non-fast-forward|\(fetch first\)/iu;

/**
 * A failed run, classified from git's stderr (the runner pins `LC_ALL=C`).
 * The message stays git's own words.
 */
export function gitCommandFailed(run: GitCommandRun): GitFailed {
  if (run.failureReason === 'timeout') {
    return failed(
      fault({ category: 'timeout', code: 'git.timeout', message: describeFailure(run) })
    );
  }
  if (run.failureReason === 'notFound') {
    return gitRefused(
      'configuration',
      'git.not-installed',
      describeFailure(run),
      'Install git and make sure it is on PATH.'
    );
  }
  const message = describeFailure(run);
  if (isNotARepository(run)) {
    return gitRefused('input', 'git.not-a-repository', message);
  }
  if (AUTHENTICATION_FAILED.test(run.stderr)) {
    return gitRefused(
      'authorization',
      'git.authentication-failed',
      message,
      'Check the credentials git uses for this remote.'
    );
  }
  if (PUSH_REJECTED.test(run.stderr)) {
    return gitRefused(
      'conflict',
      'git.push-rejected',
      message,
      'Fetch and integrate the remote changes, then push again.'
    );
  }
  return gitRefused('conflict', 'git.command-failed', message);
}

/**
 * Combine a failed run's stderr/stdout into one actionable message. A
 * discriminated `failureReason` wins, so a timeout or missing binary reports
 * accurately instead of a stale exit code.
 */
export function describeFailure(run: GitCommandRun): string {
  if (run.failureReason === 'timeout') {
    return 'git command timed out';
  }
  if (run.failureReason === 'notFound') {
    return 'git is not installed or not on PATH';
  }
  const stderr = run.stderr.trim();
  if (stderr.length > 0) {
    return stderr;
  }
  const stdout = run.stdout.trim();
  if (stdout.length > 0) {
    return stdout;
  }
  return `git exited with code ${run.exitCode ?? 'null (terminated by signal)'}`;
}
