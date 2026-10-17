/**
 * The owner-only record path, offline: the real cassette recorder forwards to
 * a loopback stand-in that replays the committed `openai-parallel-tool-calls`
 * cassette, so no request leaves the machine and no real key exists. The
 * recording must pass its checks, be written beside the task, and replay.
 */
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseProviderCassette } from '@brainstrike/test-utils/provider-cassette';
import { afterEach, expect, test } from 'vitest';
import { startProviderBoundary } from '../src/provider-boundary.js';
import { recordEvalCassette } from '../src/record.js';
import { readTaskCassette, runEvalTask } from '../src/runner.js';
import { loadEvalTask } from '../src/task.js';

const TASK = resolve(import.meta.dirname, '../tasks/parallel-read');
const OFFLINE_KEY = 'agent-evals-offline-recorder-key';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

/** A copy of parallel-read with no cassette yet, as an owner would record it. */
async function uncassettedTask(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-evals-record-'));
  roots.push(root);
  const dir = join(root, 'parallel-read');
  await cp(TASK, dir, { recursive: true });
  const { cassette: _cassette, ...task } = JSON.parse(
    await readFile(join(dir, 'task.json'), 'utf8')
  );
  await writeFile(join(dir, 'task.json'), `${JSON.stringify(task, null, 2)}\n`);
  return dir;
}

test('records a task through the recorder, checks it, writes it and replays it', {
  timeout: 300_000,
}, async () => {
  const dir = await uncassettedTask();
  const standIn = await startProviderBoundary({
    cassette: await readTaskCassette(await loadEvalTask(TASK)),
    substitutions: [],
  });
  try {
    const summary = await recordEvalCassette({
      env: { ['BRAINSTRIKE_OPENAI_API_KEY']: OFFLINE_KEY },
      model: 'openai::gpt-6-luna',
      taskDir: dir,
      upstreams: standIn.env,
    });
    expect(summary).toMatch(
      /^Recorded parallel-read on openai::gpt-6-luna: \d+ exchange\(s\); the recorded run passed\.$/u
    );
    expect(standIn.refusals()).toEqual([]);
    expect(standIn.unserved()).toEqual([]);
  } finally {
    await standIn.close();
  }
  const written = JSON.parse(await readFile(join(dir, 'task.json'), 'utf8'));
  expect(written).toMatchObject({ cassette: 'cassette.json', model: 'openai::gpt-6-luna' });
  const cassette = await readFile(join(dir, 'cassette.json'), 'utf8');
  expect(cassette).not.toContain(OFFLINE_KEY);
  expect(parseProviderCassette(cassette, 'cassette.json').scenario).toBe(
    'agent-evals/parallel-read'
  );
  const replayed = await runEvalTask(await loadEvalTask(dir), { batch: 'record', mode: 'replay' });
  expect(replayed).toMatchObject({ pass: true, reason: null });
});

test('never records in CI or without the provider key in the shell', async () => {
  const dir = await uncassettedTask();
  await expect(
    recordEvalCassette({
      env: { ['BRAINSTRIKE_OPENAI_API_KEY']: OFFLINE_KEY, ['CI']: 'true' },
      model: 'openai::gpt-6-luna',
      taskDir: dir,
    })
  ).rejects.toThrow(/never runs in CI/u);
  await expect(
    recordEvalCassette({ env: {}, model: 'openai::gpt-6-luna', taskDir: dir })
  ).rejects.toThrow(/needs BRAINSTRIKE_OPENAI_API_KEY or OPENAI_API_KEY/u);
});
