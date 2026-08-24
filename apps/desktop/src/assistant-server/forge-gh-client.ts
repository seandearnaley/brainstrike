/**
 * The ONLY place the `gh` binary is invoked.
 *
 * Same discipline as `execFileGitRunner` (`../git-ipc-handlers.ts`), for the
 * same reasons: `execFile` with an ARGUMENT ARRAY (never a shell, never
 * `execSync`), a pinned environment, a bounded capture buffer, and a resolved
 * structured result instead of a rejection. The caller supplies a `cwd` that
 * has already been resolved and containment-checked against a known workspace
 * root (`resolveRootCwd`); nothing here ever chooses a directory.
 *
 * NO SILENT FALLBACKS: every failure path returns a `ForgeUnavailable` whose
 * `detail` carries gh's own message. Nothing here turns a failed lookup into
 * "this branch has no pull request".
 */
import { type ExecFileException, execFile } from 'node:child_process';
import type { ForgePullRequest, ForgeUnavailable } from '@brainstrike/types';
import { readForgeChecks, rollupForgeChecks } from '@brainstrike/types';

/** `gh` reaches the network; give it more room than a local git call, bounded. */
export const GH_TIMEOUT_MS = 20_000;
const GH_MAX_BUFFER_BYTES = 4_000_000;

/** GH_* variables carrying deliberate auth/config intent; everything else is dropped. */
const PRESERVED_GH_ENV_KEYS = new Set(['GH_CONFIG_DIR', 'GH_ENTERPRISE_TOKEN', 'GH_TOKEN']);

export interface ForgeCommandRun {
  readonly exitCode: number | null;
  readonly failureReason?: 'maxBuffer' | 'notFound' | 'timeout';
  readonly stderr: string;
  readonly stdout: string;
}

/**
 * Structural runner contract so the service is testable without spawning
 * anything. `host` is NOT a gh argument — it selects `GH_HOST` in the pinned
 * environment, which is what makes an enterprise host reachable without ever
 * inheriting the user's own `GH_HOST`.
 */
export type ForgeCommandRunner = (params: {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly host: string;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs: number;
}) => Promise<ForgeCommandRun>;

/**
 * Drop every inherited `GH_*` variable except the audited auth/config keys,
 * then pin the controls that make gh non-interactive and machine-readable. An
 * inherited `GH_HOST`/`GH_REPO` would silently redirect the lookup to a
 * different repository — exactly the class of surprise this removes.
 */
export function createPinnedGhEnvironment(
  source: NodeJS.ProcessEnv,
  host: string
): NodeJS.ProcessEnv {
  const environment = { ...source };
  const preserved = new Map<string, string>();
  for (const key of Object.keys(environment)) {
    const normalizedKey = key.toUpperCase();
    if (!normalizedKey.startsWith('GH_')) {
      continue;
    }
    const value = environment[key];
    if (value !== undefined && PRESERVED_GH_ENV_KEYS.has(normalizedKey)) {
      preserved.set(key, value);
    }
    Reflect.deleteProperty(environment, key);
  }
  for (const [key, value] of preserved) {
    environment[key] = value;
  }
  // `parseForgeRemote` may supply `URL.hostname` with IPv6 brackets (for
  // example, "[::1]"); pass that exact opaque string through unchanged.
  environment['GH_HOST'] = host;
  environment['GH_PROMPT_DISABLED'] = '1';
  environment['GH_NO_UPDATE_NOTIFIER'] = '1';
  environment['GH_PAGER'] = 'cat';
  environment['NO_COLOR'] = '1';
  environment['CLICOLOR'] = '0';
  environment['GIT_TERMINAL_PROMPT'] = '0';
  // gh's wording is never pattern-matched here, but it IS shown to the user
  // and logged; pin the locale so one failure reads the same on every host.
  environment['LC_ALL'] = 'C';
  environment['LANG'] = 'C';
  return environment;
}

function classifyGhExecError(
  error: ExecFileException
): Pick<ForgeCommandRun, 'exitCode' | 'failureReason'> {
  const code = error.code;
  const exitCode = typeof code === 'number' ? code : null;
  if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return { exitCode, failureReason: 'maxBuffer' };
  }
  if (code === 'ENOENT') {
    return { exitCode, failureReason: 'notFound' };
  }
  return error.killed === true ? { exitCode, failureReason: 'timeout' } : { exitCode };
}

export const execFileGhRunner: ForgeCommandRunner = ({ args, cwd, host, signal, timeoutMs }) =>
  new Promise<ForgeCommandRun>((resolve) => {
    execFile(
      'gh',
      [...args],
      {
        cwd,
        env: createPinnedGhEnvironment(process.env, host),
        maxBuffer: GH_MAX_BUFFER_BYTES,
        signal,
        timeout: timeoutMs,
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve({ ...classifyGhExecError(error), stderr, stdout });
          return;
        }
        resolve({ exitCode: 0, stderr, stdout });
      }
    );
  });

function describeGhFailure(run: ForgeCommandRun): string {
  if (run.failureReason === 'timeout') {
    return `gh timed out after ${GH_TIMEOUT_MS} ms.`;
  }
  if (run.failureReason === 'maxBuffer') {
    return 'gh produced more output than could be captured.';
  }
  const message = (run.stderr.trim() || run.stdout.trim()).split('\n')[0] ?? '';
  return message.length > 0 ? message : `gh exited with code ${String(run.exitCode)}.`;
}

/** `null` = gh is present. Otherwise a `gh-missing` failure in gh's own words. */
export async function detectGhCli(
  run: ForgeCommandRunner,
  cwd: string
): Promise<ForgeUnavailable | null> {
  const result = await run({
    args: ['--version'],
    cwd,
    host: 'github.com',
    timeoutMs: GH_TIMEOUT_MS,
  });
  if (result.failureReason === 'notFound') {
    return {
      detail: 'GitHub CLI (gh) was not found on PATH. Install it to see pull request status.',
      reason: 'gh-missing',
    };
  }
  if (result.exitCode !== 0) {
    return {
      detail: `GitHub CLI (gh) could not run: ${describeGhFailure(result)}`,
      reason: 'gh-missing',
    };
  }
  return null;
}

/**
 * `null` = gh holds credentials for `host`.
 *
 * HOST-SCOPED on purpose: `gh auth status` without `--hostname` exits 0 when
 * the user is logged into ANY host, which would report an enterprise
 * repository as reachable on the strength of a github.com login.
 */
export async function probeGhAuth(
  run: ForgeCommandRunner,
  cwd: string,
  host: string
): Promise<ForgeUnavailable | null> {
  const result = await run({
    args: ['auth', 'status', '--hostname', host],
    cwd,
    host,
    timeoutMs: GH_TIMEOUT_MS,
  });
  if (result.exitCode === 0) {
    return null;
  }
  return {
    detail: `GitHub CLI is not authenticated for ${host} — run \`gh auth login --hostname ${host}\`. (${describeGhFailure(result)})`,
    reason: 'gh-unauthenticated',
  };
}

const GH_PR_JSON_FIELDS =
  'number,url,title,state,isDraft,reviewDecision,statusCheckRollup,headRefOid';

const PR_STATES: ReadonlyMap<string, ForgePullRequest['state']> = new Map([
  ['CLOSED', 'closed'],
  ['MERGED', 'merged'],
  ['OPEN', 'open'],
]);

const REVIEW_DECISIONS: ReadonlySet<string> = new Set([
  'APPROVED',
  'CHANGES_REQUESTED',
  'REVIEW_REQUIRED',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ghFetchFailure(detail: string): {
  readonly failure: ForgeUnavailable;
  readonly ok: false;
} {
  return { failure: { detail, reason: 'fetch-failed' }, ok: false };
}

function readPullRequestRow(
  row: unknown
):
  | { readonly failure: ForgeUnavailable; readonly ok: false }
  | { readonly ok: true; readonly value: ForgePullRequest } {
  if (!isRecord(row)) {
    return ghFetchFailure('gh returned a pull request entry that is not an object.');
  }
  const number = row['number'];
  const url = row['url'];
  const title = row['title'];
  const headSha = row['headRefOid'];
  const rawState = row['state'];
  if (typeof number !== 'number' || !Number.isInteger(number)) {
    return ghFetchFailure('gh returned a pull request with no integer number.');
  }
  if (typeof url !== 'string' || url.length === 0) {
    return ghFetchFailure(`gh returned pull request #${number} with no URL.`);
  }
  if (typeof title !== 'string') {
    return ghFetchFailure(`gh returned pull request #${number} with no title.`);
  }
  if (typeof headSha !== 'string' || headSha.length === 0) {
    return ghFetchFailure(`gh returned pull request #${number} with no head SHA.`);
  }
  const state = typeof rawState === 'string' ? PR_STATES.get(rawState) : undefined;
  if (!state) {
    return ghFetchFailure(
      `gh returned pull request #${number} in unrecognized state "${String(rawState)}".`
    );
  }
  const checks = readForgeChecks(row['statusCheckRollup']);
  if (!checks.ok) {
    return ghFetchFailure(
      `gh returned unreadable checks for pull request #${number}: ${checks.reason}`
    );
  }
  const rawReview = row['reviewDecision'];
  const reviewDecision =
    typeof rawReview === 'string' && REVIEW_DECISIONS.has(rawReview)
      ? (rawReview as ForgePullRequest['reviewDecision'])
      : null;
  return {
    ok: true,
    value: {
      checks: checks.value,
      checksRollup: rollupForgeChecks(checks.value),
      headSha,
      isDraft: row['isDraft'] === true,
      number,
      reviewDecision,
      state,
      title,
      url,
    },
  };
}

/**
 * ONE `gh pr list` per refresh.
 *
 * `--state all` because a merged PR must still be observable (the `pr.merged`
 * timeline event and the fading badge depend on it); `--limit 1` because the
 * chip describes the branch's most recent pull request and gh returns
 * newest-first.
 *
 * `value: null` means "gh answered, and this branch has no pull request" — an
 * OBSERVED absence, a different fact from every failure above it.
 */
export async function fetchForgePullRequest(
  run: ForgeCommandRunner,
  params: { readonly branch: string; readonly cwd: string; readonly host: string }
): Promise<
  | { readonly failure: ForgeUnavailable; readonly ok: false }
  | { readonly ok: true; readonly value: ForgePullRequest | null }
> {
  const result = await run({
    args: [
      'pr',
      'list',
      '--head',
      params.branch,
      '--state',
      'all',
      '--limit',
      '1',
      '--json',
      GH_PR_JSON_FIELDS,
    ],
    cwd: params.cwd,
    host: params.host,
    timeoutMs: GH_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    return ghFetchFailure(describeGhFailure(result));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    return ghFetchFailure(
      `gh output could not be parsed as JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!Array.isArray(parsed)) {
    return ghFetchFailure('gh returned a pull request list that is not an array.');
  }
  const first = parsed[0];
  return first === undefined ? { ok: true, value: null } : readPullRequestRow(first);
}
