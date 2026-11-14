/**
 * A live run through the real standalone host, with the provider played by a
 * recorded Anthropic cassette on a loopback boundary: the host's own Anthropic
 * SDK parses real responses and its own ledger prices them, and no request
 * leaves the machine. The key is a placeholder the boundary never reads.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseProviderCassette } from '@brainstrike/test-utils/provider-cassette';
import { afterEach, describe, expect, test } from 'vitest';
import { startProviderBoundary } from '../src/provider-boundary.js';
import { providerCredentialEnvNames, runEvalBatch, runEvalTask } from '../src/runner.js';
import { type LoadedEvalTask, loadEvalTask } from '../src/task.js';

/** Haiku 5.5 thinking, then globbing the workspace's markdown files: recorded in the host lane. */
const CASSETTE = resolve(
  import.meta.dirname,
  '../../test-utils/fixtures/provider-cassettes/anthropic-reasoning-tools.json'
);
const MODEL = 'anthropic::claude-haiku-5-5';
// Under the env name the CLI hands the owner's key to the host.
const [KEY_NAME] = providerCredentialEnvNames(MODEL);
if (!KEY_NAME) {
  throw new Error(`${MODEL} names no credential env`);
}
const PLACEHOLDER_KEY = { [KEY_NAME]: 'agent-evals-test-key' };

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function cassette() {
  return parseProviderCassette(await readFile(CASSETTE, 'utf8'), CASSETTE);
}

/** A task that opens with the cassette's recorded prompt; its own model is not the one the run names. */
async function recordedTask(followUps?: readonly { prompt: string }[]): Promise<LoadedEvalTask> {
  const recorded = await cassette();
  const prompt = recorded.exchanges.find((exchange) => exchange.key.lane !== '')?.key.lane;
  if (!prompt) {
    throw new Error('The cassette has no conversation');
  }
  const root = await mkdtemp(join(tmpdir(), 'agent-evals-live-'));
  roots.push(root);
  const dir = join(root, 'count-markdown');
  await mkdir(join(dir, 'repo'), { recursive: true });
  // The recording's workspace.
  await writeFile(join(dir, 'repo', 'one.md'), '# One\n');
  await writeFile(join(dir, 'repo', 'two.md'), '# Two\n');
  await writeFile(join(dir, 'repo', 'three.txt'), 'three\n');
  await writeFile(
    join(dir, 'task.json'),
    JSON.stringify({
      ...(followUps ? { followUps } : {}),
      id: 'count-markdown',
      model: 'openai::gpt-6-luna',
      prompt,
      timeoutMs: 120_000,
      title: 'Count the markdown files',
      verify: { command: ['node', '--version'] },
    })
  );
  return await loadEvalTask(dir);
}

const replayedAnthropic = {
  credential: PLACEHOLDER_KEY,
  egress: async (substitutions: Parameters<typeof startProviderBoundary>[0]['substitutions']) =>
    startProviderBoundary({ cassette: await cassette(), substitutions }),
  mode: 'live' as const,
};

test('a live run runs the model it names, not the task’s own', async () => {
  const result = await runEvalTask(await recordedTask(), {
    ...replayedAnthropic,
    batch: 'live-model',
    model: MODEL,
  });
  expect(result.modelId).toBe(MODEL);
  // The boundary served every request from the recording, so the host asked for that model.
  expect(result).toMatchObject({ pass: true, reason: null, verdict: 'completed' });
  expect(result.thread?.spend.costUsd).toBeGreaterThan(0);
});

describe('a spend cap', () => {
  test('once the measured spend reaches it, no further turn or trial starts, and the run is cut short', async () => {
    const capUsd = 0.0001;
    const results = await runEvalBatch([await recordedTask([{ prompt: 'Now name each one.' }])], {
      ...replayedAnthropic,
      batch: 'capped',
      model: MODEL,
      spendCapUsd: capUsd,
      trials: 2,
    });
    expect(results).toHaveLength(2);
    const [stopped, notRun] = results;
    const spentUsd = stopped?.thread?.spend.costUsd;
    expect(spentUsd).toBeGreaterThan(capUsd);
    // Turn 1 completed; its spend reached the cap, so turn 2 never started.
    expect(stopped).toMatchObject({
      modelId: MODEL,
      pass: false,
      spendCap: { capUsd, cutShort: true, spentUsd },
      thread: { turns: 1 },
      trial: 1,
      verdict: 'completed',
    });
    expect(stopped?.reason).toMatch(/^The spend cap stopped the thread before turn 2: \$/u);
    expect(notRun).toMatchObject({
      modelId: null,
      pass: false,
      spendCap: { capUsd, cutShort: true, spentUsd },
      thread: null,
      trial: 2,
    });
    expect(notRun?.reason).toMatch(/^Not run: the spend cap stopped the batch: \$/u);
    // The CLI exits 0 only when every result passed, so a cut-short run never reads as a full one.
    expect(results.every((result) => result.pass)).toBe(false);
  });

  test('under it, every trial runs and the measured spend adds up across them', async () => {
    const results = await runEvalBatch([await recordedTask()], {
      ...replayedAnthropic,
      batch: 'under-cap',
      model: MODEL,
      spendCapUsd: 1,
      trials: 2,
    });
    const [first, second] = results;
    const firstUsd = first?.thread?.spend.costUsd ?? Number.NaN;
    const secondUsd = second?.thread?.spend.costUsd ?? Number.NaN;
    expect(results.map((result) => result.pass)).toEqual([true, true]);
    expect(first?.spendCap).toEqual({ capUsd: 1, cutShort: false, spentUsd: firstUsd });
    expect(second?.spendCap?.cutShort).toBe(false);
    expect(second?.spendCap?.spentUsd).toBeCloseTo(firstUsd + secondUsd, 12);
  });

  test('a run whose spend was never read leaves the spend unknown, and nothing more starts', async () => {
    const results = await runEvalBatch([await recordedTask()], {
      ...replayedAnthropic,
      batch: 'unknown-spend',
      egress: () => Promise.reject(new Error('no provider here')),
      model: MODEL,
      spendCapUsd: 1,
      trials: 2,
    });
    expect(results[0]).toMatchObject({
      reason: 'no provider here',
      spendCap: { capUsd: 1, cutShort: false, spentUsd: null },
      thread: null,
    });
    expect(results[1]).toMatchObject({
      spendCap: { capUsd: 1, cutShort: true, spentUsd: null },
      thread: null,
      trial: 2,
    });
    expect(results[1]?.reason).toMatch(
      /^Not run: the spend cap stopped the batch: the spend is unknown: count-markdown trial 1 /u
    );
  });
});
