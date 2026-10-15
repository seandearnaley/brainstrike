/**
 * ExecPolicy → sandbox-runtime config mapping (BST-1062).
 *
 * srt-runtime-free (the SandboxRuntimeConfig import is type-only), and the
 * only impure thing it does — resolving paths to their canonical on-disk form
 * — is injected, so the mapping that decides what the fence actually permits
 * stays unit-testable without spawning or touching real directories.
 */
import { realpath as realpathCallback } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, parse, sep } from 'node:path';
import { promisify } from 'node:util';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';

import { type ExecPolicy, parseExecPolicy } from '../code-execution';

/**
 * `realpath.NATIVE`, not `fs/promises`' `realpath` (BST-1074).
 *
 * Node's JS implementation walks components with `lstat`/`readlink` and copies
 * every non-symlink component VERBATIM from the input string: it resolves
 * symlinks but does NOT return the OS-canonical case. Only the native binding
 * (`realpath(3)` on macOS, `GetFinalPathNameByHandleW` on Windows) does.
 * Measured on darwin: for an on-disk `MixedCase`, the JS version returns
 * `mixedcase` while the native one returns `MixedCase`.
 *
 * The distinction is load-bearing. `isPathCoveredBy` compares directory
 * segments case-SENSITIVELY, and the always-deny containment check resolves
 * before comparing precisely so a case variant cannot dodge it. With the JS
 * resolver both guarantees evaporate on a case-insensitive volume: `~/.SSH`
 * would come back as `~/.SSH` and compare unequal to the denied `~/.ssh`.
 */
const realpathNative = promisify(realpathCallback.native);

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
 * Resolved here from `os.homedir()` rather than handed to srt as `~/...`: srt
 * resolves paths against its own process context, so a `~`-prefixed deny that
 * reaches it unexpanded is a rule that silently protects nothing. They stay
 * literal (never globbed) because a literal path is what the containment
 * checks below compare against — a glob names a region this module never
 * resolved — and because the literal re-application on top of a broader
 * `allowRead` is the srt behavior this layer verifies by execution. srt's
 * GLOB-deny handling is version-dependent and deliberately NOT relied on:
 * 0.0.72 changed macOS to re-emit glob denies (carved by the allows each one
 * covers) where they were previously clobbered by a broader allow, and on
 * Linux a glob deny still has to be expanded by ripgrep at run time. Globs
 * never reach srt from here anyway — `assertPolicyPathShape` refuses them.
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

/**
 * Resolves a path to its canonical on-disk form. Injected so unit tests can
 * exercise the mapping without a real filesystem; production passes the NATIVE realpath (see above).
 */
export type FencePathResolver = (path: string) => Promise<string>;

/** Metacharacters srt would expand into paths this module never inspected. */
const GLOB_CHARACTERS = /[*?[\]{}]/;

/** True when `candidate` is `parent` itself or lives beneath it. */
function isAtOrUnder(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(parent + sep);
}

/** True when `path` is the filesystem root (`/` on POSIX). */
function isFilesystemRoot(path: string): boolean {
  return parse(path).root === path;
}

/**
 * Shape checks, before anything touches the filesystem. Anything ambiguous is
 * refused rather than guessed:
 *
 * - a GLOB would be expanded by srt into paths this module never compared
 *   against the always-denied stores, so `allowRead: ['~/.config/*']` would
 *   silently re-open `~/.config/gcloud`. The seam has no stated need for glob
 *   paths; refusing is the non-degrading option.
 * - a `~` is rejected, never expanded — srt resolves against its own process
 *   context, so an unexpanded tilde is a rule that protects nothing.
 * - a RELATIVE path is resolved by srt against the Node process cwd, not
 *   `scratchDir`, so the grant lands somewhere the caller did not write.
 * - a `..` segment makes the written policy and the effective policy differ.
 */
function assertPolicyPathShape(field: string, path: string): string {
  if (GLOB_CHARACTERS.test(path)) {
    throw new FencePolicyError(
      `${field} entry ${JSON.stringify(path)} contains a glob; the fence needs literal paths it can compare against the always-denied credential stores.`
    );
  }
  if (path === '~' || path.startsWith('~/') || path.startsWith(`~${sep}`)) {
    throw new FencePolicyError(
      `${field} entry ${JSON.stringify(path)} is home-relative; pass an absolute path, since srt would resolve a tilde against its own process context.`
    );
  }
  if (!isAbsolute(path)) {
    throw new FencePolicyError(
      `${field} entry ${JSON.stringify(path)} is not absolute; a relative path would be resolved against this process's cwd, not scratchDir.`
    );
  }
  if (path.split(sep).includes('..')) {
    throw new FencePolicyError(
      `${field} entry ${JSON.stringify(path)} contains a '..' segment; the written policy and the effective policy must be the same path.`
    );
  }
  return normalize(path);
}

/**
 * Canonicalizes a path that MUST exist.
 *
 * Case sensitivity is a filesystem property, not a platform one — APFS is
 * case-insensitive by default but can be formatted case-sensitive — so this
 * never folds case. `realpath` returns the canonical on-disk spelling instead:
 * a case-insensitive volume resolves `~/.SSH` to `~/.ssh` naturally, and a
 * case-sensitive volume correctly keeps them distinct. Folding case would make
 * containment MORE permissive, i.e. a false PERMIT at validation that then
 * fails opaquely when srt applies the real policy; not folding can only
 * produce a false reject, which is confusing but never unsafe.
 *
 * A path that does not exist has no canonical form, so it is surfaced rather
 * than guessed at.
 */
async function resolveExisting(
  field: string,
  path: string,
  resolvePath: FencePathResolver
): Promise<string> {
  try {
    return await resolvePath(path);
  } catch (error) {
    throw new FencePolicyError(
      `${field} entry ${JSON.stringify(path)} could not be resolved (${error instanceof Error ? error.message : String(error)}); a path that does not exist has no canonical form, so the fence will not guess at what it would grant.`
    );
  }
}

/**
 * Canonicalizes a path that MAY be absent. Used for deny rules: a host without
 * `~/.gnupg` is normal, and there is nothing to canonicalize — or to re-open.
 * The literal is kept so srt still receives the rule.
 */
async function resolveOptional(path: string, resolvePath: FencePathResolver): Promise<string> {
  try {
    return await resolvePath(path);
  } catch {
    return path;
  }
}

/**
 * Builds the srt config for one execution.
 *
 * `scratchDir` is always writable — it is the execution's working directory
 * and holds the script srt runs — and is listed first so the mapping is
 * obvious when the config is logged.
 *
 * Four ways a policy can re-open what the fence always denies are refused here
 * rather than silently dropped — every one of them because srt would honour
 * the written policy in a way that does not match what it says:
 *
 * 1. an `allowRead` AT or UNDER an always-denied store (re-bound inside the
 *    deny's tmpfs on Linux);
 * 2. an `allowRead` on the filesystem ROOT (srt's nested-deny re-emission
 *    misses it — see the comment on that check);
 * 3. an `allowRead` naming exactly a path the same policy DENIES (the allow
 *    wins and the deny vanishes);
 * 4. an `allowWrite` AT or UNDER an always-denied store (a read-write bind
 *    re-opens the store for READING on Linux).
 *
 * An `allowRead` ANCESTOR short of the root is fine — srt re-applies the
 * nested deny on top of it. Every comparison runs on canonical paths, so none
 * of them can be dodged by a symlink or a case variant on a case-insensitive
 * volume.
 */
export async function buildSandboxRuntimeConfig(
  policy: ExecPolicy,
  scratchDir: string,
  resolvePath: FencePathResolver = realpathNative
): Promise<SandboxRuntimeConfig> {
  const parsed = parseExecPolicy(policy);

  const resolvedScratchDir = await resolveExisting(
    'scratchDir',
    assertPolicyPathShape('scratchDir', scratchDir),
    resolvePath
  );

  const allowRead = await Promise.all(
    (parsed.allowRead ?? []).map((path) =>
      resolveExisting('allowRead', assertPolicyPathShape('allowRead', path), resolvePath)
    )
  );
  const allowWrite = await Promise.all(
    parsed.allowWrite.map((path) =>
      resolveExisting('allowWrite', assertPolicyPathShape('allowWrite', path), resolvePath)
    )
  );
  // Deny rules canonicalize best-effort: a rule naming a path this host does
  // not have is not an error, it is a host without that credential store.
  const denyRead = await Promise.all(
    (parsed.denyRead ?? []).map((path) =>
      resolveOptional(assertPolicyPathShape('denyRead', path), resolvePath)
    )
  );
  const alwaysDenyRead = await Promise.all(
    ALWAYS_DENY_READ_PATHS.map((path) => resolveOptional(path, resolvePath))
  );

  for (const [index, readable] of allowRead.entries()) {
    const written = JSON.stringify(parsed.allowRead?.[index] ?? readable);
    // A root-wide read grant is REFUSED, not narrowed. The always-denied
    // stores survive an ANCESTOR allowRead only because srt re-emits the
    // nested deny after the broader allow — and through srt 0.0.75 that
    // re-emission tests `denied.startsWith(allowed + '/')`, which for
    // `allowed === '/'` compares against `'//'` and never matches. Re-measured
    // on 0.0.75's generated profile in BST-1669 (the emission line is byte-
    // identical to 0.0.73's): the root allow is still
    // emitted AFTER the credential deny under last-match-wins, so this guard
    // is still load-bearing, not redundant. Measured on macOS (BST-1071,
    // fence-escape-resistance.integration.spec.ts): with `allowRead: ['/']`,
    // sandboxed code read `~/.ssh/*` and the contents of `~/.config/gh/
    // hosts.yml`. Linux masks denied directories with tmpfs and was not
    // affected, which is exactly why this must be refused here rather than
    // left to the platform. Any ancestor SHORT of the root re-emits correctly
    // and stays allowed.
    if (isFilesystemRoot(readable)) {
      throw new FencePolicyError(
        `allowRead entry ${written} resolves to the filesystem root ${readable}; a whole-filesystem read grant is not expressible, because it stops the always-denied credential stores from being re-applied on top of it. Name the directories the run actually needs.`
      );
    }
    const reopened = alwaysDenyRead.find((denied) => isAtOrUnder(readable, denied));
    if (reopened) {
      throw new FencePolicyError(
        `allowRead entry ${written} resolves to ${readable}, which would re-open the always-denied credential store ${reopened}; remove it or narrow the policy.`
      );
    }
    // An allowRead that names EXACTLY a path the policy also denies is a
    // contradiction, and srt resolves it silently in the allow's favour: the
    // re-emission that keeps a nested deny alive tests
    // `denied.startsWith(allowed + '/')`, which is false when the two are
    // equal, so the last-match-wins allow stands and the caller's denyRead is
    // discarded without a word. Refused rather than pinned, because a policy
    // that does not mean what it says is the quiet degradation this codebase
    // forbids. A deny NESTED under a broader allow is a different, supported
    // shape — srt re-emits that one — and stays legal.
    const contradicted = denyRead.find((denied) => denied === readable);
    if (contradicted) {
      throw new FencePolicyError(
        `allowRead entry ${written} resolves to ${readable}, which the same policy also names in denyRead; srt would resolve that contradiction in favour of the allow and silently drop the deny. Remove one of the two, or deny a path NESTED inside the allowed one.`
      );
    }
  }

  for (const [index, writable] of allowWrite.entries()) {
    // A WRITE grant on a credential store re-opens it for READING on Linux.
    // bubblewrap masks a denied directory with `--tmpfs`, then re-binds every
    // allowed write path that is at or under that directory with a read-write
    // `--bind` — and there is no such thing as a write bind you cannot read.
    // So `allowWrite: ['~/.ssh']` would hand back the very store
    // ALWAYS_DENY_READ_PATHS exists to keep out, through a channel the
    // allowRead containment check above never looks at. macOS keeps write and
    // read authority separate and is not affected, which makes this the mirror
    // image of the root-allowRead finding: there, macOS leaked and Linux held.
    // Refused in the policy layer for the same reason — the guarantee must not
    // depend on which platform the run lands on.
    const reopened = alwaysDenyRead.find((denied) => isAtOrUnder(writable, denied));
    if (reopened) {
      throw new FencePolicyError(
        `allowWrite entry ${JSON.stringify(parsed.allowWrite[index] ?? writable)} resolves to ${writable}, which sits inside the always-denied credential store ${reopened}; a write grant there re-opens the store for reading on Linux. Remove it or narrow the policy.`
      );
    }
  }

  return {
    filesystem: {
      allowRead,
      allowWrite: [resolvedScratchDir, ...allowWrite],
      denyRead: [...alwaysDenyRead, ...denyRead],
      denyWrite: [],
    },
    // An empty allowedDomains list IS the no-network state: srt still routes
    // through its proxy and denies every connection matching no allowed
    // domain. There is deliberately no separate network on/off flag to drift.
    network: { allowedDomains: [...parsed.allowedDomains], deniedDomains: [] },
  };
}
