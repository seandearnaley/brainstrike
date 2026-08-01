/**
 * ExecPolicy → sandbox-runtime config mapping (BST-1062).
 *
 * Pure and srt-runtime-free (the SandboxRuntimeConfig import is type-only), so
 * the mapping — the part that decides what the fence actually permits — is
 * unit-testable without spawning anything.
 */
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { platform } from 'node:process';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';

import { type ExecPolicy, execPolicySchema } from '../code-execution';

/**
 * Home-relative names of the credential stores sandboxed code may never read,
 * whatever the policy says.
 *
 * Scope: credential/secret stores an agent has no business reading. It is
 * deliberately NOT a general privacy blocklist — broad read denial is the
 * policy's job via `denyRead`.
 */
const ALWAYS_DENY_READ_HOME_RELATIVE: readonly string[] = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.config/gcloud',
  '.config/gh',
  '.kube',
  '.docker',
  '.netrc',
  '.npmrc',
  '.pypirc',
];

/**
 * The always-denied stores as ABSOLUTE paths.
 *
 * Resolved here from `os.homedir()` rather than handed to srt as `~/...`: a
 * path this sensitive should not depend on another package's tilde expansion,
 * and every path crossing the sandbox boundary is absolute for the same
 * reason. They stay literal (never globbed) because a literal deny is the one
 * srt re-applies on top of a broader `allowRead`; a glob deny is not
 * re-emitted and could be re-opened.
 */
export const ALWAYS_DENY_READ_PATHS: readonly string[] = ALWAYS_DENY_READ_HOME_RELATIVE.map(
  (relative) => join(homedir(), relative)
);

export class FencePolicyError extends Error {
  readonly code = 'fence_policy_invalid' as const;

  constructor(message: string) {
    super(message);
    this.name = 'FencePolicyError';
  }
}

export function isFencePolicyError(value: unknown): value is FencePolicyError {
  return value instanceof FencePolicyError;
}

function expandTilde(path: string): string {
  if (path === '~') {
    return homedir();
  }
  if (path.startsWith('~/') || path.startsWith(`~${sep}`)) {
    return homedir() + path.slice(1);
  }
  return path;
}

/** Metacharacters srt would expand into paths this module never inspected. */
const GLOB_CHARACTERS = /[*?[\]{}]/;

/**
 * Case-insensitive on the platforms whose default filesystem is: otherwise
 * `~/.SSH` compares unequal to `~/.ssh` on APFS and slips past containment.
 */
const FILESYSTEM_IS_CASE_INSENSITIVE = platform === 'darwin' || platform === 'win32';

function canonical(path: string): string {
  const resolved = resolve(expandTilde(path));
  return FILESYSTEM_IS_CASE_INSENSITIVE ? resolved.toLowerCase() : resolved;
}

/** True when `candidate` is `parent` itself or lives beneath it. */
function isAtOrUnder(candidate: string, parent: string): boolean {
  const normalizedCandidate = canonical(candidate);
  const normalizedParent = canonical(parent);
  return (
    normalizedCandidate === normalizedParent ||
    normalizedCandidate.startsWith(normalizedParent + sep)
  );
}

/**
 * Every policy path is normalized to the exact string srt receives, and
 * anything ambiguous is refused rather than guessed:
 *
 * - a GLOB would be expanded by srt into paths this module never compared
 *   against the always-denied stores, so `allowRead: ['~/.config/*']` would
 *   silently re-open `~/.config/gcloud`. The seam has no stated need for glob
 *   paths; refusing is the non-degrading option.
 * - a RELATIVE path is resolved by srt against the Node process cwd, not
 *   `scratchDir`, so the grant lands somewhere the caller did not write.
 * - a `..` segment makes the written policy and the effective policy differ.
 *
 * Tilde is expanded HERE so the containment guard below and srt operate on
 * the same bytes.
 */
function normalizePolicyPath(field: string, path: string): string {
  if (GLOB_CHARACTERS.test(path)) {
    throw new FencePolicyError(
      `${field} entry ${JSON.stringify(path)} contains a glob; the fence needs literal paths it can compare against the always-denied credential stores.`
    );
  }
  const expanded = expandTilde(path);
  if (!isAbsolute(expanded)) {
    throw new FencePolicyError(
      `${field} entry ${JSON.stringify(path)} is not absolute; a relative path would be resolved against this process's cwd, not scratchDir.`
    );
  }
  if (expanded.split(sep).includes('..')) {
    throw new FencePolicyError(
      `${field} entry ${JSON.stringify(path)} contains a '..' segment; the written policy and the effective policy must be the same path.`
    );
  }
  return normalize(expanded);
}

/**
 * Builds the srt config for one execution.
 *
 * `scratchDir` is always writable — it is the execution's working directory
 * and holds the script srt runs — and is listed first so the mapping is
 * obvious when the config is logged.
 *
 * An `allowRead` entry that sits AT or UNDER an always-denied credential store
 * throws instead of being dropped: on Linux such an entry is re-bound inside
 * the deny's tmpfs and really would re-open the store, and silently discarding
 * it would be exactly the quiet degradation this codebase forbids. An
 * ANCESTOR entry is fine — srt re-applies the nested deny on top of it on both
 * platforms.
 */
export function buildSandboxRuntimeConfig(
  policy: ExecPolicy,
  scratchDir: string
): SandboxRuntimeConfig {
  const parsed = execPolicySchema.parse(policy);

  if (!isAbsolute(scratchDir)) {
    throw new FencePolicyError(
      `scratchDir must be an absolute path so the fence cannot depend on an implicit cwd; received ${JSON.stringify(scratchDir)}.`
    );
  }

  const allowRead = (parsed.allowRead ?? []).map((path) => normalizePolicyPath('allowRead', path));
  const allowWrite = parsed.allowWrite.map((path) => normalizePolicyPath('allowWrite', path));
  const denyRead = (parsed.denyRead ?? []).map((path) => normalizePolicyPath('denyRead', path));

  for (const readable of allowRead) {
    const reopened = ALWAYS_DENY_READ_PATHS.find((denied) => isAtOrUnder(readable, denied));
    if (reopened) {
      throw new FencePolicyError(
        `allowRead entry ${JSON.stringify(readable)} would re-open the always-denied credential store ${reopened}; remove it or narrow the policy.`
      );
    }
  }

  return {
    filesystem: {
      allowRead,
      allowWrite: [normalize(scratchDir), ...allowWrite],
      denyRead: [...ALWAYS_DENY_READ_PATHS, ...denyRead],
      denyWrite: [],
    },
    // An empty allowedDomains list IS the no-network state: srt still routes
    // through its proxy and denies every connection matching no allowed
    // domain. There is deliberately no separate network on/off flag to drift.
    network: { allowedDomains: [...parsed.allowedDomains], deniedDomains: [] },
  };
}
