import {
  createMcpLabRunnerDeadline,
  MAX_MCP_LAB_CASE_TIMEOUT_MS,
  MAX_MCP_LAB_RUN_TIMEOUT_MS,
  MCP_LAB_RUNNER_CASE_IDS,
  MCP_LAB_RUNNER_CASES,
  MCP_LAB_RUNNER_PROFILE_CASE_IDS,
  MCP_LAB_RUNNER_PROFILE_TIMEOUTS,
  MCP_LAB_RUNNER_PROFILES,
  McpLabRunnerDeadlineError,
  MIN_MCP_LAB_CASE_TIMEOUT_MS,
  MIN_MCP_LAB_RUN_TIMEOUT_MS,
  selectMcpLabRunnerCases,
} from '../src/runner-manifest';
import { MCP_LAB_SCENARIO_IDS } from '../src/scenario';

describe('MCP verifier runner manifest', () => {
  it('owns one stable closed case registry over every canonical executable scenario', () => {
    expect(MCP_LAB_RUNNER_PROFILES).toEqual(['pr', 'exhaustive']);
    expect(MCP_LAB_RUNNER_CASE_IDS).toEqual([
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
    ]);
    expect(MCP_LAB_RUNNER_CASES.map(({ id }) => id)).toEqual(MCP_LAB_RUNNER_CASE_IDS);
    expect(new Set(MCP_LAB_RUNNER_CASES.map(({ scenarioId }) => scenarioId))).toEqual(
      new Set(MCP_LAB_SCENARIO_IDS)
    );
    expect(
      MCP_LAB_RUNNER_CASES.every(({ scenarioId }) =>
        (MCP_LAB_SCENARIO_IDS as readonly string[]).includes(scenarioId)
      )
    ).toBe(true);
  });

  it('selects deterministic frozen representative and exhaustive profiles', () => {
    const representative = selectMcpLabRunnerCases({ profile: 'pr' });
    const exhaustive = selectMcpLabRunnerCases({ profile: 'exhaustive' });

    expect(representative.cases.map(({ id }) => id)).toEqual([
      'modern-http-in-process',
      'legacy-http-loopback',
      'oauth-http-loopback',
      'modern-stdio',
      'modern-tasks-in-process',
      'modern-apps-in-process',
    ]);
    expect(exhaustive.cases.map(({ id }) => id)).toEqual(MCP_LAB_RUNNER_CASE_IDS);
    expect(new Set(representative.cases).isSubsetOf(new Set(exhaustive.cases))).toBe(true);
    expect(representative.cases).not.toEqual(exhaustive.cases);
    expect(Object.isFrozen(representative)).toBe(true);
    expect(Object.isFrozen(representative.cases)).toBe(true);
    expect(representative.cases.every(Object.isFrozen)).toBe(true);
  });

  it('allows an explicit stable subset only within the selected profile', () => {
    expect(
      selectMcpLabRunnerCases({
        caseIds: ['modern-stdio', 'modern-http-in-process'],
        profile: 'pr',
      }).cases.map(({ id }) => id)
    ).toEqual(['modern-stdio', 'modern-http-in-process']);
    expect(() =>
      selectMcpLabRunnerCases({ caseIds: ['modern-http-loopback'], profile: 'pr' })
    ).toThrow(/not part of profile "pr"/i);
  });

  it.each([
    undefined,
    null,
    [],
    {},
    { profile: 'missing' },
    { extra: true, profile: 'pr' },
    { caseIds: [], profile: 'pr' },
    { caseIds: ['missing'], profile: 'exhaustive' },
    { caseIds: ['modern-stdio', 'modern-stdio'], profile: 'exhaustive' },
    { caseIds: undefined, profile: 'pr' },
    { caseTimeoutMs: undefined, profile: 'pr' },
    { profile: 'pr', runTimeoutMs: undefined },
    {
      caseIds: new Array(MCP_LAB_RUNNER_PROFILE_CASE_IDS.pr.length + 1).fill('modern-stdio'),
      profile: 'pr',
    },
  ])('rejects malformed or ambiguous selection %j', (input) => {
    expect(() => selectMcpLabRunnerCases(input)).toThrow(/invalid MCP lab runner selection/i);
  });

  it.each([
    { caseTimeoutMs: MIN_MCP_LAB_CASE_TIMEOUT_MS - 1, profile: 'pr' },
    { caseTimeoutMs: MAX_MCP_LAB_CASE_TIMEOUT_MS + 1, profile: 'pr' },
    { caseTimeoutMs: 100.5, profile: 'pr' },
    { profile: 'pr', runTimeoutMs: MIN_MCP_LAB_RUN_TIMEOUT_MS - 1 },
    { profile: 'pr', runTimeoutMs: MAX_MCP_LAB_RUN_TIMEOUT_MS + 1 },
    { caseTimeoutMs: 2000, profile: 'pr', runTimeoutMs: 1999 },
  ])('rejects unbounded timeout selection %j', (input) => {
    expect(() => selectMcpLabRunnerCases(input)).toThrow(/invalid MCP lab runner selection/i);
  });

  it('uses bounded profile defaults and snapshots explicit timeout overrides', () => {
    const defaults = selectMcpLabRunnerCases({ profile: 'pr' });
    const selected = selectMcpLabRunnerCases({
      caseTimeoutMs: 2500,
      profile: 'exhaustive',
      runTimeoutMs: 12_000,
    });

    expect(defaults).toMatchObject({ caseTimeoutMs: 10_000, runTimeoutMs: 90_000 });
    expect(selected).toMatchObject({ caseTimeoutMs: 2500, runTimeoutMs: 12_000 });
  });

  it('keeps run ceilings above the sum of sequential per-case ceilings', () => {
    for (const profile of MCP_LAB_RUNNER_PROFILES) {
      const timeouts = MCP_LAB_RUNNER_PROFILE_TIMEOUTS[profile];
      expect(timeouts.runTimeoutMs).toBeGreaterThan(
        MCP_LAB_RUNNER_PROFILE_CASE_IDS[profile].length * timeouts.caseTimeoutMs
      );
    }
  });

  it('provides a monotonic injectable deadline that fails visibly on expiry or clock regression', () => {
    let now = 100;
    const deadline = createMcpLabRunnerDeadline(50, () => now);

    expect(deadline.remainingMs()).toBe(50);
    now = 149;
    expect(deadline.remainingMs()).toBe(1);
    deadline.assertActive('modern-stdio');
    now = 150;
    expect(deadline.remainingMs()).toBe(0);
    expect(() => deadline.assertActive('modern-stdio')).toThrow(McpLabRunnerDeadlineError);
    expect(() => deadline.assertActive('modern-stdio')).toThrow(/modern-stdio.*50 ms/i);

    now = 99;
    expect(() => deadline.remainingMs()).toThrow(/clock moved backwards/i);
  });

  it('uses a monotonic clock by default', () => {
    const deadline = createMcpLabRunnerDeadline(100);
    expect(deadline.remainingMs()).toBeGreaterThan(0);
  });
});
