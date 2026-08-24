/**
 * Forge (GitHub/GitLab) identity + pull-request contracts, and the three pure
 * functions W4 needs on BOTH sides of the bridge.
 *
 * Everything here is I/O-free so it can be unit-tested without a repository,
 * a network, or the `gh` binary: the main process parses remotes and
 * normalizes `gh` JSON with it, and the renderer re-derives a checks rollup
 * from the cached `checks_json` with the same code.
 *
 * NO SILENT FALLBACKS: every function that can fail returns a discriminated
 * result carrying a human-readable `reason`. Nothing here ever answers
 * "no pull request" for something it merely failed to understand.
 */

export type ForgeKind = 'github' | 'gitlab' | 'unknown';

export interface ForgeRemoteIdentity {
  readonly forge: ForgeKind;
  /** Lowercased hostname with no port and no userinfo. */
  readonly host: string;
  /** Full namespace path — a GitLab subgroup keeps its slashes. */
  readonly owner: string;
  readonly repo: string;
}

export type ForgeRemoteParseResult =
  | { readonly ok: false; readonly reason: string }
  | { readonly ok: true; readonly value: ForgeRemoteIdentity };

export type ForgeCheckConclusion =
  | 'action_required'
  | 'cancelled'
  | 'failure'
  | 'neutral'
  | 'pending'
  | 'skipped'
  | 'success'
  | 'timed_out';

export interface ForgeCheck {
  readonly conclusion: ForgeCheckConclusion;
  readonly name: string;
  readonly url: string | null;
}

export type ForgeChecksRollup = 'failing' | 'none' | 'passing' | 'pending';

export type ForgePrState = 'closed' | 'merged' | 'open';

export type ForgeReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED';

export interface ForgePullRequest {
  readonly checks: readonly ForgeCheck[];
  readonly checksRollup: ForgeChecksRollup;
  readonly headSha: string;
  readonly isDraft: boolean;
  readonly number: number;
  readonly reviewDecision: ForgeReviewDecision | null;
  readonly state: ForgePrState;
  readonly title: string;
  readonly url: string;
}

/** Why PR status cannot be shown. Each variant is rendered with its `detail`. */
export type ForgeUnavailableReason =
  | 'detached-head'
  | 'fetch-failed'
  | 'gh-missing'
  | 'gh-unauthenticated'
  | 'no-remote'
  | 'unparsable-remote'
  | 'unsupported-forge';

export interface ForgeUnavailable {
  /** Always non-empty — this string is what the UI shows the user. */
  readonly detail: string;
  readonly reason: ForgeUnavailableReason;
}

/**
 * What the composer chip renders.
 *
 * - `pr` — a fresh observation.
 * - `stale` — the last known PR PLUS the failure that stopped the refresh; the
 *   chip shows the PR with a stale glyph and the failure in its popover.
 * - `none` — a successful observation that found no PR for this branch.
 * - `unavailable` — no observation is possible at all; no chip, reason shown
 *   in the BranchChip's forge diagnostic.
 */
export type ForgePrStatus =
  | {
      readonly failure: ForgeUnavailable;
      readonly kind: 'stale';
      readonly observedAt: string;
      readonly pullRequest: ForgePullRequest;
    }
  | { readonly failure: ForgeUnavailable; readonly kind: 'unavailable' }
  | { readonly kind: 'none'; readonly observedAt: string }
  | { readonly kind: 'pr'; readonly observedAt: string; readonly pullRequest: ForgePullRequest };

export type ForgeResult<T> =
  | { readonly error: string; readonly ok: false }
  | { readonly ok: true; readonly value: T };

export type ForgePrTransition = 'checks' | 'merged' | 'opened';

/** One-way main→renderer push on `forge:prUpdated`. */
export interface ForgePrUpdatedEvent {
  readonly branch: string;
  /** Monotonic per-main-process counter; consumers drop stale deliveries. */
  readonly generation: number;
  readonly pullRequest: ForgePullRequest | null;
  readonly repoCommonDir: string;
  readonly transitions: readonly ForgePrTransition[];
}

/** One `brainstrike_forge_prs` row, projected for list-wide rendering. */
export interface ForgePrCacheEntry {
  readonly branch: string;
  readonly checksRollup: ForgeChecksRollup;
  readonly isDraft: boolean;
  readonly number: number;
  readonly repoCommonDir: string;
  readonly state: ForgePrState;
  readonly url: string;
}

const SUPPORTED_PROTOCOLS = new Set(['git+ssh:', 'git:', 'http:', 'https:', 'ssh:']);
// `host:path` with no scheme — git's scp-like syntax. A Windows drive letter
// (`C:\repos\x`) is excluded by requiring at least two host characters and a
// non-backslash path start.
const SCP_LIKE = /^(?:[^@/\\]+@)?(?<host>[^:/\\]{2,}):(?<path>[^\\].*)$/u;

function classifyForgeHost(host: string): ForgeKind {
  const labels = host.split('.');
  if (labels.includes('github')) {
    return 'github';
  }
  if (labels.includes('gitlab')) {
    return 'gitlab';
  }
  return 'unknown';
}

function splitOwnerRepo(rawPath: string, host: string): ForgeRemoteParseResult {
  const trimmed = rawPath.replace(/^\/+/u, '').replace(/\/+$/u, '');
  const withoutSuffix = trimmed.endsWith('.git') ? trimmed.slice(0, -'.git'.length) : trimmed;
  const segments = withoutSuffix.split('/').filter((segment) => segment.length > 0);
  if (segments.length < 2) {
    return {
      ok: false,
      reason: `The remote path "${rawPath}" is not an owner/repo path.`,
    };
  }
  const repo = segments.at(-1) as string;
  const owner = segments.slice(0, -1).join('/');
  return { ok: true, value: { forge: classifyForgeHost(host), host, owner, repo } };
}

/**
 * Parse a git remote URL into a forge identity. Accepts the three forms git
 * itself accepts for a network remote (scp-like `git@host:owner/repo.git`,
 * `ssh://`/`git://`, and `http(s)://`) and REFUSES anything else with a reason
 * — a local path remote is a legitimate configuration, not a parse bug, and
 * saying so is what keeps the BranchChip honest.
 */
export function parseForgeRemote(remoteUrl: string): ForgeRemoteParseResult {
  const trimmed = remoteUrl.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'The remote URL is empty.' };
  }
  if (trimmed.includes('://')) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return { ok: false, reason: `The remote URL "${trimmed}" could not be parsed.` };
    }
    if (!SUPPORTED_PROTOCOLS.has(url.protocol)) {
      return {
        ok: false,
        reason: `The remote URL uses protocol "${url.protocol}", which is not a forge protocol.`,
      };
    }
    if (url.hostname.length === 0) {
      return { ok: false, reason: `The remote URL "${trimmed}" has no host.` };
    }
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(url.pathname);
    } catch {
      return {
        ok: false,
        reason: `The remote URL "${trimmed}" has a malformed percent-escape in its path.`,
      };
    }
    return splitOwnerRepo(decodedPath, url.hostname.toLowerCase());
  }
  const scp = SCP_LIKE.exec(trimmed);
  const host = scp?.groups?.['host'];
  const scpPath = scp?.groups?.['path'];
  if (!(host && scpPath)) {
    return {
      ok: false,
      reason: `The remote "${trimmed}" is a local or unrecognized remote, not a forge URL.`,
    };
  }
  return splitOwnerRepo(scpPath, host.toLowerCase());
}

/**
 * Which remote a forge lookup should read, as an explicit four-rung ladder.
 * Every rung is stated, and the bottom of the ladder is a REASON, never a
 * silent `null` the caller could mistake for "no PR".
 */
export function resolveForgeRemoteName(input: {
  readonly configuredRemote: string | null;
  readonly remotes: readonly string[];
}):
  | { readonly ok: false; readonly reason: string }
  | { readonly ok: true; readonly value: string } {
  const { configuredRemote, remotes } = input;
  if (configuredRemote !== null) {
    return remotes.includes(configuredRemote)
      ? { ok: true, value: configuredRemote }
      : {
          ok: false,
          reason: `The current branch tracks remote "${configuredRemote}", which no longer exists.`,
        };
  }
  if (remotes.includes('origin')) {
    return { ok: true, value: 'origin' };
  }
  const sole = remotes.length === 1 ? remotes[0] : undefined;
  if (sole !== undefined) {
    return { ok: true, value: sole };
  }
  if (remotes.length === 0) {
    return { ok: false, reason: 'The repository has no git remotes.' };
  }
  return {
    ok: false,
    reason: `The repository has ${remotes.length} remotes and no "origin" — set a branch upstream to choose one.`,
  };
}

const CHECK_RUN_CONCLUSIONS: Readonly<Record<string, ForgeCheckConclusion>> = {
  ['ACTION_REQUIRED']: 'action_required',
  ['CANCELLED']: 'cancelled',
  ['FAILURE']: 'failure',
  ['NEUTRAL']: 'neutral',
  ['SKIPPED']: 'skipped',
  ['STALE']: 'neutral',
  ['STARTUP_FAILURE']: 'failure',
  ['SUCCESS']: 'success',
  ['TIMED_OUT']: 'timed_out',
};

const STATUS_CONTEXT_STATES: Readonly<Record<string, ForgeCheckConclusion>> = {
  ['ERROR']: 'failure',
  ['EXPECTED']: 'pending',
  ['FAILURE']: 'failure',
  ['PENDING']: 'pending',
  ['SUCCESS']: 'success',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readCheckNode(
  node: Record<string, unknown>,
  index: number
):
  | { readonly ok: false; readonly reason: string }
  | { readonly ok: true; readonly value: ForgeCheck } {
  const rawName = node['name'] ?? node['context'];
  if (typeof rawName !== 'string' || rawName.trim().length === 0) {
    return { ok: false, reason: `Check node ${index} has no name or context.` };
  }
  const rawUrl = node['detailsUrl'] ?? node['targetUrl'];
  const url = typeof rawUrl === 'string' && rawUrl.length > 0 ? rawUrl : null;
  const status = node['status'];
  if (typeof status === 'string') {
    if (status !== 'COMPLETED') {
      return { ok: true, value: { conclusion: 'pending', name: rawName, url } };
    }
    const conclusion = typeof node['conclusion'] === 'string' ? node['conclusion'] : '';
    const mapped = CHECK_RUN_CONCLUSIONS[conclusion];
    if (!mapped) {
      return {
        ok: false,
        reason: `Check "${rawName}" completed with unrecognized conclusion "${conclusion}".`,
      };
    }
    return { ok: true, value: { conclusion: mapped, name: rawName, url } };
  }
  const state = typeof node['state'] === 'string' ? node['state'] : '';
  const mappedState = STATUS_CONTEXT_STATES[state];
  if (!mappedState) {
    return {
      ok: false,
      reason: `Status context "${rawName}" has unrecognized state "${state}".`,
    };
  }
  return { ok: true, value: { conclusion: mappedState, name: rawName, url } };
}

/**
 * Normalize a `gh … --json statusCheckRollup` value (a FLAT array of CheckRun
 * / StatusContext nodes for `gh pr list`) into `ForgeCheck[]`.
 *
 * A node this cannot read fails the WHOLE parse. Dropping it would render a
 * partial checks list as a complete one — exactly the "12/12 green" lie the
 * chip must never tell.
 */
export function readForgeChecks(
  value: unknown
):
  | { readonly ok: false; readonly reason: string }
  | { readonly ok: true; readonly value: readonly ForgeCheck[] } {
  if (value === null || value === undefined) {
    return { ok: true, value: [] };
  }
  if (!Array.isArray(value)) {
    return { ok: false, reason: 'The status check rollup is not an array.' };
  }
  const checks: ForgeCheck[] = [];
  for (const [index, node] of value.entries()) {
    if (!isRecord(node)) {
      return { ok: false, reason: `Check node ${index} is not an object.` };
    }
    const read = readCheckNode(node, index);
    if (!read.ok) {
      return read;
    }
    checks.push(read.value);
  }
  return { ok: true, value: checks };
}

const FAILING_CONCLUSIONS: ReadonlySet<ForgeCheckConclusion> = new Set<ForgeCheckConclusion>([
  'action_required',
  'cancelled',
  'failure',
  'timed_out',
]);

/** Failing beats pending beats passing; an empty list is `none`, not `passing`. */
export function rollupForgeChecks(checks: readonly ForgeCheck[]): ForgeChecksRollup {
  if (checks.length === 0) {
    return 'none';
  }
  if (checks.some((check) => FAILING_CONCLUSIONS.has(check.conclusion))) {
    return 'failing';
  }
  return checks.some((check) => check.conclusion === 'pending') ? 'pending' : 'passing';
}
