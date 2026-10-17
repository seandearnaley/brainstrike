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
    maxStepToolCalls: 1,
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
    expect(lines[0]).toMatch(/^task\s+mode\s+result\s+steps\s+tools\s+in tok\s+out tok\s+wall ms/u);
    expect(lines[1]).toMatch(/^fix-failing-test\s+scripted\s+PASS\s+4\s+3\s+4\s+4\s+812/u);
    expect(lines[2]).toMatch(
      /^rename-symbol\s+scripted\s+FAIL\s+-\s+-\s+-\s+-\s+-\s+The host committed no run$/u
    );
    expect(lines.at(-1)).toBe('1/2 passed');
  });
});
