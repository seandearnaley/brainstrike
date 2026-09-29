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

/** Which RENDERER event asked for a refresh. Each carries its own minimum interval. */
export type ForgeRendererRefreshReason = 'invalidation' | 'user' | 'window';

/**
 * Every reason the SERVICE accepts. `'shell'` is main-only: it is raised by the
 * shell-output correlator when the agent's own command ran `gh pr create`, an
 * event that moves no ref and therefore never reaches the git-metadata watcher.
 * It is deliberately NOT part of {@link ForgeRendererRefreshReason} — a
 * renderer claiming it would be claiming an observation it cannot have made.
 */
export type ForgeRefreshReason = ForgeRendererRefreshReason | 'shell';

/**
 * The forge identity of one repository, plus the reason there is none.
 * `identity` and `failure` are mutually exclusive: exactly one is non-null.
 */
export interface ForgeIdentityState {
  readonly failure: ForgeUnavailable | null;
  readonly identity: ForgeRemoteIdentity | null;
  readonly repoCommonDir: string;
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
 * - `stale` — the last known OBSERVATION plus the failure that stopped the
 *   refresh; the chip shows it with a stale glyph and the failure in its
 *   popover. `pullRequest` is `null` when the last known observation was
 *   itself a `none` (gh had already reported no pull request the last time it
 *   answered) — this is still an honest "last known state, refresh currently
 *   failing", never a fabricated PR. A REFRESH whose gh-detection/auth
 *   preflight failed reuses this shape too, whenever the cache holds a
 *   durable observation — a bare `unavailable` would hide it behind a
 *   transient probe failure.
 * - `none` — a successful observation that found no PR for this branch.
 * - `unavailable` — no observation is possible at all; no chip, reason shown
 *   in the BranchChip's forge diagnostic.
 * - `unknown` — never observed: no `gh` call has answered for this key yet
 *   (no cached row, no recorded failure). Distinct from `none` on purpose —
 *   `none` is an OBSERVED absence with a real `observedAt`, and fabricating
 *   one for "we simply haven't looked" would lie to a "Last checked …"
 *   affordance built on that timestamp.
 */
export type ForgePrStatus =
  | {
      readonly failure: ForgeUnavailable;
      readonly kind: 'stale';
      readonly observedAt: string;
      readonly pullRequest: ForgePullRequest | null;
    }
  | { readonly failure: ForgeUnavailable; readonly kind: 'unavailable' }
  | { readonly kind: 'none'; readonly observedAt: string }
  | { readonly kind: 'pr'; readonly observedAt: string; readonly pullRequest: ForgePullRequest }
  | { readonly kind: 'unknown' };

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

/**
 * The `(repoCommonDir, branch)` composite key `brainstrike_forge_prs` is
 * keyed by, encoded as one string so it can be a `Map`/`Set` key on both
 * sides of the main/renderer bridge.
 *
 * NUL-separated rather than joined with a printable delimiter: neither a
 * filesystem path nor a git branch name can contain a NUL byte, so the
 * encoding is unambiguous — a `/`, `:`, or other printable separator could
 * collide with a path or branch that happens to contain it. Main
 * (`forge-service.ts`, `forge-pr-cache.ts`) and the renderer
 * (`use-forge-pr-cache.ts`, `thread-forge-pr-resolution.ts`) both key their
 * lookups through this one function so the two sides of the bridge can never
 * drift onto different encodings of the same identity.
 */
export function forgePrCacheKey(repoCommonDir: string, branch: string): string {
  return `${repoCommonDir}\0${branch}`;
}

/**
 * Every conclusion a normalized, CACHED `ForgeCheck` can carry — i.e. the
 * `ForgeCheckConclusion` union restated as a runtime set so a cached row can
 * be validated against it. This is deliberately distinct from
 * `readForgeChecks` above: that function parses RAW `gh --json
 * statusCheckRollup` nodes (CheckRun/StatusContext shapes, GraphQL-cased
 * conclusions); `readChecks` below parses the ALREADY-NORMALIZED
 * `ForgeCheck[]` a cache row's `checks_json` column stores, which
 * `readForgeChecks` + `rollupForgeChecks` produced when the row was written.
 */
export const FORGE_CHECK_CONCLUSIONS: ReadonlySet<string> = new Set<ForgeCheckConclusion>([
  'action_required',
  'cancelled',
  'failure',
  'neutral',
  'pending',
  'skipped',
  'success',
  'timed_out',
]);

/**
 * Read a cache row's `checks_json` column back into `ForgeCheck[]`.
 *
 * `checks_json` round-trips the normalized `ForgeCheck[]` written by
 * `writeForgePrCacheEntry`. PGlite may hand a `jsonb` column back as a parsed
 * value OR as its JSON text depending on the transport in play (direct
 * handle vs. db-host client, and main vs. renderer); both are faithful
 * encodings of the SAME value, so this accepts either.
 *
 * THROWS on anything it cannot interpret, rather than coercing or dropping
 * the malformed entry: a cache row this code cannot fully understand must not
 * be rendered as a PR with an incomplete or wrong checks list — that would be
 * the "12/12 green" lie `readForgeChecks`'s own doc warns about, just
 * reached from the cache instead of a live `gh` call. The caller (both
 * `readForgePrCacheEntry` on main and `projectForgePrRows` on the renderer)
 * fails the WHOLE row/projection on this throw rather than rendering a
 * partial answer.
 */
export function readChecks(value: unknown): readonly ForgeCheck[] {
  const source = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  if (!Array.isArray(source)) {
    throw new Error('Cached forge checks are unreadable: the value is not an array.');
  }
  return source.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`Cached forge check ${index} is not an object.`);
    }
    const conclusion = entry['conclusion'];
    const name = entry['name'];
    const url = entry['url'];
    if (typeof conclusion !== 'string' || !FORGE_CHECK_CONCLUSIONS.has(conclusion)) {
      throw new Error(`Cached forge check ${index} has an unrecognized conclusion.`);
    }
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new Error(`Cached forge check ${index} has no name.`);
    }
    if (!(url === null || typeof url === 'string')) {
      throw new Error(`Cached forge check ${index} has an unreadable URL.`);
    }
    return { conclusion: conclusion as ForgeCheckConclusion, name, url };
  });
}

const SUPPORTED_PROTOCOLS = new Set(['git+ssh:', 'git:', 'http:', 'https:', 'ssh:']);
// `host:path` with no scheme — git's scp-like syntax. A Windows drive letter
// (`C:\repos\x`) is excluded by requiring at least two host characters and a
// non-backslash path start.
const SCP_LIKE = /^(?:[^@/\\]+@)?(?<host>[^:/\\]{2,}):(?<path>[^\\].*)$/u;

/**
 * A host is only `github`/`gitlab` when it EQUALS the canonical domain or its
 * FIRST label is the forge name (covering enterprise hosts like
 * `github.acme.com`). A middle-label match (`foo.github.attacker.example`)
 * or a substring match (`mygithub.com`) is deliberately `unknown` — matching
 * on `.split('.').includes(...)` would let an attacker-controlled subdomain
 * masquerade as GitHub.
 */
function classifyForgeHost(host: string): ForgeKind {
  if (host === 'github.com') {
    return 'github';
  }
  if (host === 'gitlab.com') {
    return 'gitlab';
  }
  const firstLabel = host.split('.')[0];
  if (firstLabel === 'github') {
    return 'github';
  }
  if (firstLabel === 'gitlab') {
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
  const forge = classifyForgeHost(host);
  // GitHub owner/repo is always exactly two segments; a GitHub URL with more
  // segments (e.g. ".../acme/widgets/tree/main") is a page URL, not a
  // remote, and treating its trailing segments as part of the owner would
  // fabricate a namespace that doesn't exist. GitLab keeps subgroup
  // namespaces (more than two segments is legitimate there).
  if (forge === 'github' && segments.length !== 2) {
    return {
      ok: false,
      reason: `The remote "${host}/${withoutSuffix}" has ${segments.length} path segments; a GitHub remote must be exactly "owner/repo".`,
    };
  }
  const repo = segments.at(-1) as string;
  const owner = segments.slice(0, -1).join('/');
  return { ok: true, value: { forge, host, owner, repo } };
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

/**
 * Prototype-safe lookup on a plain-object map: `map[key]` alone resolves
 * inherited `Object.prototype` keys (`constructor`, `toString`, `__proto__`)
 * to truthy junk that would slip past `if (!mapped)` and roll a check up as
 * passing. `Object.hasOwn` closes that off.
 */
function lookupOwn<V>(map: Readonly<Record<string, V>>, key: string): V | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

// GitHub's CheckStatusState GraphQL enum: the only non-COMPLETED values a
// CheckRun can report. Anything else is a status this code doesn't
// understand and must not silently fold into "pending".
const IN_PROGRESS_CHECK_STATUSES: ReadonlySet<string> = new Set([
  'IN_PROGRESS',
  'PENDING',
  'QUEUED',
  'REQUESTED',
  'WAITING',
]);

function readCheckRunNode(
  rawName: string,
  url: string | null,
  node: Record<string, unknown>
):
  | { readonly ok: false; readonly reason: string }
  | { readonly ok: true; readonly value: ForgeCheck } {
  const status = node['status'];
  if (typeof status !== 'string' || status.length === 0) {
    return { ok: false, reason: `Check "${rawName}" has an empty or missing status.` };
  }
  if (status !== 'COMPLETED') {
    if (!IN_PROGRESS_CHECK_STATUSES.has(status)) {
      return { ok: false, reason: `Check "${rawName}" has unrecognized status "${status}".` };
    }
    return { ok: true, value: { conclusion: 'pending', name: rawName, url } };
  }
  const conclusion = typeof node['conclusion'] === 'string' ? node['conclusion'] : '';
  const mapped = lookupOwn(CHECK_RUN_CONCLUSIONS, conclusion);
  if (mapped === undefined) {
    return {
      ok: false,
      reason: `Check "${rawName}" completed with unrecognized conclusion "${conclusion}".`,
    };
  }
  return { ok: true, value: { conclusion: mapped, name: rawName, url } };
}

function readStatusContextNode(
  rawName: string,
  url: string | null,
  node: Record<string, unknown>
):
  | { readonly ok: false; readonly reason: string }
  | { readonly ok: true; readonly value: ForgeCheck } {
  const state = node['state'];
  if (typeof state !== 'string' || state.length === 0) {
    return { ok: false, reason: `Status context "${rawName}" has an empty or missing state.` };
  }
  const mappedState = lookupOwn(STATUS_CONTEXT_STATES, state);
  if (mappedState === undefined) {
    return {
      ok: false,
      reason: `Status context "${rawName}" has unrecognized state "${state}".`,
    };
  }
  return { ok: true, value: { conclusion: mappedState, name: rawName, url } };
}

/**
 * `__typename` (present on every `gh --json` GraphQL node) decides CheckRun
 * vs. StatusContext when it's there. The structural sniff (does a `status`
 * key exist?) is only a fallback for callers that omit `__typename` — and an
 * EMPTY `status` string never counts as "present": that was the "pending"
 * lie an empty status used to tell (falling into the CheckRun branch,
 * `status !== 'COMPLETED'` → pending) instead of the explicit failure the
 * malformed node deserves.
 */
function isCheckRunNode(node: Record<string, unknown>): boolean {
  const typename = node['__typename'];
  if (typename === 'CheckRun') {
    return true;
  }
  if (typename === 'StatusContext') {
    return false;
  }
  return 'status' in node;
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
  return isCheckRunNode(node)
    ? readCheckRunNode(rawName, url, node)
    : readStatusContextNode(rawName, url, node);
}

/**
 * Normalize a `gh … --json statusCheckRollup` value (a FLAT array of CheckRun
 * / StatusContext nodes for `gh pr list`) into `ForgeCheck[]`.
 *
 * A node this cannot read fails the WHOLE parse. Dropping it would render a
 * partial checks list as a complete one — exactly the "12/12 green" lie the
 * chip must never tell.
 *
 * `null`/`undefined` is REJECTED, not treated as "no checks" — verified live
 * 2026-08-24 that `gh pr view --json statusCheckRollup` always emits an
 * array, empty included, and never `null`, so a missing/null value here
 * indicates a malformed or truncated payload upstream, not an empty rollup.
 * An actual empty rollup is expressed as `[]`, which still maps to `ok: true,
 * value: []` (and rolls up to `none`).
 */
export function readForgeChecks(
  value: unknown
):
  | { readonly ok: false; readonly reason: string }
  | { readonly ok: true; readonly value: readonly ForgeCheck[] } {
  if (!Array.isArray(value)) {
    return {
      ok: false,
      reason: 'The status check rollup is not an array; expected an array (use [] for no checks).',
    };
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
