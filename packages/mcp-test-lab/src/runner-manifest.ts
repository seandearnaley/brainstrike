import type { McpLabScenarioId } from './scenario.js';

export const MIN_MCP_LAB_CASE_TIMEOUT_MS = 100;
export const MIN_MCP_LAB_RUN_TIMEOUT_MS = 100;
export const MAX_MCP_LAB_CASE_TIMEOUT_MS = 60_000;
export const MAX_MCP_LAB_RUN_TIMEOUT_MS = 600_000;

export const MCP_LAB_RUNNER_PROFILES = Object.freeze(['pr', 'exhaustive'] as const);
export type McpLabRunnerProfile = (typeof MCP_LAB_RUNNER_PROFILES)[number];

export const MCP_LAB_RUNNER_CASE_IDS = Object.freeze([
  'modern-http-in-process',
  'modern-http-loopback',
  'legacy-http-in-process',
  'legacy-http-loopback',
  'oauth-http-loopback',
  'modern-stdio',
  'modern-tasks-in-process',
  'modern-tasks-loopback',
  'modern-apps-in-process',
  'modern-apps-loopback',
] as const);
export type McpLabRunnerCaseId = (typeof MCP_LAB_RUNNER_CASE_IDS)[number];

export interface McpLabRunnerCase {
  readonly execution: 'in-process' | 'loopback' | undefined;
  readonly id: McpLabRunnerCaseId;
  readonly scenarioId: McpLabScenarioId;
}

function runnerCase(
  id: McpLabRunnerCaseId,
  scenarioId: McpLabScenarioId,
  execution: McpLabRunnerCase['execution']
): McpLabRunnerCase {
  return Object.freeze({ execution, id, scenarioId });
}

export const MCP_LAB_RUNNER_CASES = Object.freeze([
  runnerCase('modern-http-in-process', 'modern-reference', 'in-process'),
  runnerCase('modern-http-loopback', 'modern-reference', 'loopback'),
  runnerCase('legacy-http-in-process', 'legacy-reference', 'in-process'),
  runnerCase('legacy-http-loopback', 'legacy-reference', 'loopback'),
  runnerCase('oauth-http-loopback', 'oauth-reference', 'loopback'),
  runnerCase('modern-stdio', 'stdio-reference', undefined),
  runnerCase('modern-tasks-in-process', 'tasks-reference', 'in-process'),
  runnerCase('modern-tasks-loopback', 'tasks-reference', 'loopback'),
  runnerCase('modern-apps-in-process', 'apps-reference', 'in-process'),
  runnerCase('modern-apps-loopback', 'apps-reference', 'loopback'),
] as const satisfies readonly McpLabRunnerCase[]);

const CASE_BY_ID: ReadonlyMap<McpLabRunnerCaseId, McpLabRunnerCase> = new Map(
  MCP_LAB_RUNNER_CASES.map((entry) => [entry.id, entry])
);

export const MCP_LAB_RUNNER_PROFILE_CASE_IDS = Object.freeze({
  exhaustive: MCP_LAB_RUNNER_CASE_IDS,
  pr: Object.freeze([
    'modern-http-in-process',
    'legacy-http-loopback',
    'oauth-http-loopback',
    'modern-stdio',
    'modern-tasks-in-process',
    'modern-apps-in-process',
  ] as const satisfies readonly McpLabRunnerCaseId[]),
} as const satisfies Readonly<Record<McpLabRunnerProfile, readonly McpLabRunnerCaseId[]>>);

export const MCP_LAB_RUNNER_PROFILE_TIMEOUTS = Object.freeze({
  // Run ceilings keep headroom above the sum of per-case ceilings (cases run
  // sequentially) so a merely slow run fails per case, never as a run timeout.
  exhaustive: Object.freeze({ caseTimeoutMs: 20_000, runTimeoutMs: 270_000 }),
  pr: Object.freeze({ caseTimeoutMs: 10_000, runTimeoutMs: 90_000 }),
} as const satisfies Readonly<
  Record<McpLabRunnerProfile, { readonly caseTimeoutMs: number; readonly runTimeoutMs: number }>
>);

export interface McpLabRunnerSelection {
  readonly cases: readonly McpLabRunnerCase[];
  readonly caseTimeoutMs: number;
  readonly profile: McpLabRunnerProfile;
  readonly runTimeoutMs: number;
}

function invalidSelection(message: string): never {
  throw new Error(`Invalid MCP lab runner selection: ${message}`);
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseProfile(value: unknown): McpLabRunnerProfile {
  if (value !== 'pr' && value !== 'exhaustive') {
    invalidSelection('profile must be "pr" or "exhaustive"');
  }
  return value;
}

function boundedInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    invalidSelection(`${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

const TIMEOUT_BOUNDS = Object.freeze({
  caseTimeoutMs: Object.freeze({
    maximum: MAX_MCP_LAB_CASE_TIMEOUT_MS,
    minimum: MIN_MCP_LAB_CASE_TIMEOUT_MS,
  }),
  runTimeoutMs: Object.freeze({
    maximum: MAX_MCP_LAB_RUN_TIMEOUT_MS,
    minimum: MIN_MCP_LAB_RUN_TIMEOUT_MS,
  }),
});

function boundedTimeout(value: unknown, field: keyof typeof TIMEOUT_BOUNDS): number {
  const { maximum, minimum } = TIMEOUT_BOUNDS[field];
  return boundedInteger(value, field, minimum, maximum);
}

function isRunnerCaseId(value: string): value is McpLabRunnerCaseId {
  return (MCP_LAB_RUNNER_CASE_IDS as readonly string[]).includes(value);
}

function selectCaseIds(
  input: unknown,
  profile: McpLabRunnerProfile
): readonly McpLabRunnerCaseId[] {
  const profileIds: readonly McpLabRunnerCaseId[] = MCP_LAB_RUNNER_PROFILE_CASE_IDS[profile];
  if (!Array.isArray(input)) {
    invalidSelection('caseIds must be an array');
  }
  if (input.length < 1 || input.length > profileIds.length) {
    invalidSelection(`caseIds must contain from 1 to ${profileIds.length} entries`);
  }
  const selected: McpLabRunnerCaseId[] = [];
  const seen = new Set<McpLabRunnerCaseId>();
  for (const value of input) {
    if (typeof value !== 'string' || !isRunnerCaseId(value)) {
      invalidSelection('caseIds contains an unknown case');
    }
    if (!profileIds.includes(value)) {
      invalidSelection(`case "${value}" is not part of profile "${profile}"`);
    }
    if (seen.has(value)) {
      invalidSelection(`caseIds contains duplicate case "${value}"`);
    }
    seen.add(value);
    selected.push(value);
  }
  return Object.freeze(selected);
}

export function selectMcpLabRunnerCases(input: unknown): McpLabRunnerSelection {
  if (!isPlainRecord(input)) {
    invalidSelection('expected a plain object');
  }
  const allowedKeys = new Set(['profile', 'caseIds', 'caseTimeoutMs', 'runTimeoutMs']);
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !allowedKeys.has(key)) {
      invalidSelection(`unknown field "${String(key)}"`);
    }
  }
  if (!Object.hasOwn(input, 'profile')) {
    invalidSelection('profile is required');
  }
  const profile = parseProfile(input['profile']);
  const defaults = MCP_LAB_RUNNER_PROFILE_TIMEOUTS[profile];
  const caseTimeoutMs = boundedTimeout(
    Object.hasOwn(input, 'caseTimeoutMs') ? input['caseTimeoutMs'] : defaults.caseTimeoutMs,
    'caseTimeoutMs'
  );
  const runTimeoutMs = boundedTimeout(
    Object.hasOwn(input, 'runTimeoutMs') ? input['runTimeoutMs'] : defaults.runTimeoutMs,
    'runTimeoutMs'
  );
  if (runTimeoutMs < caseTimeoutMs) {
    invalidSelection('runTimeoutMs must be greater than or equal to caseTimeoutMs');
  }
  const caseIds = Object.hasOwn(input, 'caseIds')
    ? selectCaseIds(input['caseIds'], profile)
    : MCP_LAB_RUNNER_PROFILE_CASE_IDS[profile];
  const cases = Object.freeze(
    caseIds.map((id) => {
      const entry = CASE_BY_ID.get(id);
      if (!entry) {
        return invalidSelection(`case registry is missing "${id}"`);
      }
      return entry;
    })
  );
  return Object.freeze({ cases, caseTimeoutMs, profile, runTimeoutMs });
}

export class McpLabRunnerDeadlineError extends Error {
  constructor(caseId: string, timeoutMs: number) {
    super(`MCP lab runner case "${caseId}" exceeded ${timeoutMs} ms deadline`);
    this.name = 'McpLabRunnerDeadlineError';
  }
}

export interface McpLabRunnerDeadline {
  assertActive(caseId: string): void;
  /** Reads and records the monotonic clock; throws if that clock moves backwards. */
  remainingMs(): number;
}

export function createMcpLabRunnerDeadline(
  timeoutMs: number,
  /** Must return a monotonic clock value. Wall-clock sources such as Date.now are invalid. */
  readNow: () => number = () => performance.now()
): McpLabRunnerDeadline {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_MCP_LAB_RUN_TIMEOUT_MS) {
    throw new Error('Invalid MCP lab runner deadline timeout');
  }
  const startedAt = readNow();
  if (!Number.isFinite(startedAt)) {
    throw new Error('Invalid MCP lab runner clock value');
  }
  let lastNow = startedAt;
  const expiresAt = startedAt + timeoutMs;
  function remainingMs(): number {
    const now = readNow();
    if (!Number.isFinite(now)) {
      throw new Error('Invalid MCP lab runner clock value');
    }
    if (now < lastNow) {
      throw new Error('MCP lab runner clock moved backwards');
    }
    lastNow = now;
    return Math.max(0, expiresAt - now);
  }
  return Object.freeze({
    assertActive(caseId: string): void {
      if (remainingMs() === 0) {
        throw new McpLabRunnerDeadlineError(caseId, timeoutMs);
      }
    },
    remainingMs,
  });
}
