import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  appendEvalResults,
  type EvalResult,
  formatEvalSummary,
  resultsFilePath,
} from '../src/results.js';

const PASSED: EvalResult = {
  batch: 'batch-1',
  finishedAt: '2026-10-17T11:00:05.000Z',
  metrics: {
    approvals: 2,
    inputTokens: 4,
    maxStepCallsByTool: { brainstrike_readWorkspaceFile: 1 },
    outputTokens: 4,
    steps: 4,
    toolCalls: { brainstrike_readWorkspaceFile: 1, brainstrike_stringReplaceWorkspaceFile: 2 },
    wallMs: 812,
  },
  mode: 'scripted',
  modelId: 'scripted::fix-failing-test',
  pass: true,
  reason: null,
  spendCap: null,
  startedAt: '2026-10-17T11:00:00.000Z',
  task: 'fix-failing-test',
  thread: {
    compactions: { agentic: 2, deterministic: 0 },
    probes: { passed: 1, total: 1 },
    spend: {
      bySource: {
        chat: { costUsd: 0.0101, inputTokens: 4, outputTokens: 4 },
        'compaction-summary': { costUsd: 0.0022, inputTokens: 900, outputTokens: 80 },
      },
      cacheReadTokens: 300,
      cacheWriteTokens: 0,
      costUsd: 0.0123,
      unreportedCalls: 0,
    },
    turns: 3,
  },
  trial: 1,
  verdict: 'completed',
  verifierExitCode: 0,
};
const FAILED: EvalResult = {
  ...PASSED,
  metrics: null,
  modelId: null,
  pass: false,
  reason: 'The host committed no run',
  task: 'rename-symbol',
  thread: null,
  verdict: null,
  verifierExitCode: null,
};

/** A live run the spend cap stopped after its first turn. */
const CUT_SHORT: EvalResult = {
  ...PASSED,
  mode: 'live',
  modelId: 'anthropic::claude-haiku-5-5',
  pass: false,
  reason:
    'The spend cap stopped the thread before turn 2: $1.0312 measured reaches the $1.0000 cap',
  spendCap: { capUsd: 1, cutShort: true, spentUsd: 1.0312 },
  verifierExitCode: null,
};
/** The trial after it, which the cap never started. */
const NOT_RUN: EvalResult = {
  ...FAILED,
  mode: 'live',
  reason: 'Not run: the spend cap stopped the batch: $1.0312 measured reaches the $1.0000 cap',
  spendCap: { capUsd: 1, cutShort: true, spentUsd: 1.0312 },
  trial: 2,
};

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('results writer', () => {
  test('names the file by UTC date and mode', () => {
    expect(resultsFilePath('/r', new Date('2026-10-17T23:30:00-04:00'), 'replay')).toBe(
      join('/r', '2026-10-18-replay.jsonl')
    );
  });

  test('appends one JSON line per task, keeping earlier lines', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-evals-results-'));
    roots.push(root);
    const file = join(root, 'nested', '2026-10-17-scripted.jsonl');
    await appendEvalResults(file, [PASSED, FAILED]);
    await appendEvalResults(file, [PASSED, CUT_SHORT, NOT_RUN]);
    const lines = (await readFile(file, 'utf8')).trimEnd().split('\n');
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      PASSED,
      FAILED,
      PASSED,
      CUT_SHORT,
      NOT_RUN,
    ]);
  });

  test('refuses a spend cap that is not a positive amount', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-evals-results-'));
    roots.push(root);
    const uncapped = { ...CUT_SHORT, spendCap: { capUsd: 0, cutShort: true, spentUsd: 1 } };
    await expect(appendEvalResults(join(root, 'out.jsonl'), [uncapped])).rejects.toThrow(/capUsd/u);
  });

  test('refuses a result whose pass and reason disagree, writing nothing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-evals-results-'));
    roots.push(root);
    const file = join(root, 'out.jsonl');
    await expect(appendEvalResults(file, [{ ...PASSED, reason: 'but why' }])).rejects.toThrow(
      /reason/u
    );
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('formatEvalSummary', () => {
  test('one row per task with its metrics and reason, then the pass count', () => {
    const summary = formatEvalSummary([PASSED, FAILED]);
    const lines = summary.split('\n');
    expect(lines[0]).toMatch(
      /^task\s+mode\s+trial\s+result\s+steps\s+tools\s+in tok\s+out tok\s+wall ms\s+turns\s+compact\s+probes\s+cost \$/u
    );
    expect(lines[1]).toMatch(
      /^fix-failing-test\s+scripted\s+1\s+PASS\s+4\s+3\s+4\s+4\s+812\s+3\s+2\s+1\/1\s+0\.0123/u
    );
    expect(lines[2]).toMatch(
      /^rename-symbol\s+scripted\s+1\s+FAIL\s+-\s+-\s+-\s+-\s+-\s+-\s+-\s+-\s+-\s+The host committed no run$/u
    );
    expect(lines.at(-1)).toBe('1/2 passed');
  });

  test('a thread with an unpriced call shows no cost, and one with no probes shows none', () => {
    const unpriced = {
      ...PASSED,
      thread: {
        ...PASSED.thread!,
        probes: { passed: 0, total: 0 },
        spend: { ...PASSED.thread!.spend, costUsd: null },
      },
    };
    expect(formatEvalSummary([unpriced]).split('\n')[1]).toMatch(/812\s+3\s+2\s+-\s+-$/u);
  });

  test('several trials of a task end with how many of them passed', () => {
    const trial = (number: number, pass: boolean): EvalResult => ({
      ...PASSED,
      pass,
      reason: pass ? null : 'Turn 3’s answer leaves out: 8443',
      trial: number,
    });
    const lines = formatEvalSummary([
      trial(1, true),
      trial(2, false),
      trial(3, true),
      FAILED,
    ]).split('\n');
    expect(lines.slice(-3)).toEqual([
      '2/4 passed',
      'fix-failing-test: 2/3 trials passed',
      'rename-symbol: 0/1 trials passed',
    ]);
  });

  test('a capped run ends with its measured spend against the cap and what the cap cut short', () => {
    const under = { ...PASSED, spendCap: { capUsd: 1, cutShort: false, spentUsd: 0.4 } };
    expect(formatEvalSummary([under]).split('\n').at(-1)).toBe(
      'Spend cap $1.0000: $0.4000 measured'
    );
    const lines = formatEvalSummary([CUT_SHORT, NOT_RUN]).split('\n');
    expect(lines[2]).toMatch(/^rename-symbol\s+live\s+2\s+FAIL\s.*Not run: the spend cap/u);
    expect(lines.slice(-2)).toEqual([
      '0/2 passed',
      'Spend cap $1.0000: $1.0312 measured; cut short, 2 run(s) stopped or not run',
    ]);
    const unknown = { ...NOT_RUN, spendCap: { capUsd: 1, cutShort: true, spentUsd: null } };
    expect(formatEvalSummary([unknown]).split('\n').at(-1)).toBe(
      'Spend cap $1.0000: unknown spend; cut short, 1 run(s) stopped or not run'
    );
  });
});
