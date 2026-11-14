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
    await appendEvalResults(file, [PASSED]);
    const lines = (await readFile(file, 'utf8')).trimEnd().split('\n');
    expect(lines.map((line) => JSON.parse(line))).toEqual([PASSED, FAILED, PASSED]);
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
});
