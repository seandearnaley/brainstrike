import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { decodeEvalScript, decodeEvalTask, loadEvalTask, loadEvalTasks } from '../src/task.js';

const VALID = {
  id: 'fix-failing-test',
  model: 'openai::gpt-6-luna',
  prompt: 'Make the failing test pass.',
  timeoutMs: 60_000,
  title: 'Fix a failing unit test',
  verify: { command: ['node', '--test', '.verify/sum.test.ts'] },
};

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function taskDir(id: string, files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-evals-task-'));
  roots.push(root);
  const dir = join(root, id);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(resolve(dir, file, '..'), { recursive: true });
    await writeFile(join(dir, file), content);
  }
  return dir;
}

describe('decodeEvalTask', () => {
  test('decodes the task format, with an optional cassette', () => {
    expect(decodeEvalTask(VALID, 'task.json')).toEqual(VALID);
    expect(decodeEvalTask({ ...VALID, cassette: 'cassette.json' }, 'task.json').cassette).toBe(
      'cassette.json'
    );
  });

  test.each([
    ['an unknown field', { ...VALID, extra: true }],
    ['a missing prompt', { ...VALID, prompt: undefined }],
    ['an empty prompt', { ...VALID, prompt: '' }],
    ['a model without a provider', { ...VALID, model: 'gpt-6-luna' }],
    ['a non-positive timeout', { ...VALID, timeoutMs: 0 }],
    ['a fractional timeout', { ...VALID, timeoutMs: 1.5 }],
    ['an empty verify command', { ...VALID, verify: { command: [] } }],
    ['an id that is not a slug', { ...VALID, id: 'Fix Failing' }],
  ])('refuses %s, naming the file', (_name, value) => {
    expect(() => decodeEvalTask(value, 'tasks/x/task.json')).toThrow(/tasks\/x\/task\.json/u);
  });
});

describe('decodeEvalScript', () => {
  test('decodes tool calls in order', () => {
    const script = {
      calls: [{ input: { path: 'a.ts' }, toolId: 'brainstrike_readWorkspaceFile' }],
    };
    expect(decodeEvalScript(script, 'script.json')).toEqual(script);
  });

  test('refuses a script with no calls or a nameless call', () => {
    expect(() => decodeEvalScript({ calls: [] }, 'script.json')).toThrow(/script\.json/u);
    expect(() => decodeEvalScript({ calls: [{ input: {}, toolId: '' }] }, 'script.json')).toThrow(
      /script\.json/u
    );
  });
});

describe('loadEvalTask', () => {
  test('loads a task folder with its repo, hidden verifier, script and cassette', async () => {
    const dir = await taskDir('fix-failing-test', {
      'cassette.json': '{}',
      'repo/src/sum.ts': 'export const sum = 1;\n',
      'script.json': JSON.stringify({ calls: [{ input: {}, toolId: 'tool' }] }),
      'task.json': JSON.stringify({ ...VALID, cassette: 'cassette.json' }),
      'verify/sum.test.ts': '',
    });
    const loaded = await loadEvalTask(dir);
    expect(loaded).toEqual({
      cassettePath: join(dir, 'cassette.json'),
      dir,
      repoDir: join(dir, 'repo'),
      script: { calls: [{ input: {}, toolId: 'tool' }] },
      task: { ...VALID, cassette: 'cassette.json' },
      verifyDir: join(dir, 'verify'),
    });
  });

  test('refuses a folder whose name is not the task id', async () => {
    const dir = await taskDir('another-name', {
      'repo/a.txt': 'a',
      'task.json': JSON.stringify(VALID),
    });
    await expect(loadEvalTask(dir)).rejects.toThrow(/another-name.*fix-failing-test/u);
  });

  test('refuses a task without a starting repo', async () => {
    const dir = await taskDir('fix-failing-test', { 'task.json': JSON.stringify(VALID) });
    await expect(loadEvalTask(dir)).rejects.toThrow(/repo/u);
  });

  test('refuses a cassette that does not exist', async () => {
    const dir = await taskDir('fix-failing-test', {
      'repo/a.txt': 'a',
      'task.json': JSON.stringify({ ...VALID, cassette: 'missing.json' }),
    });
    await expect(loadEvalTask(dir)).rejects.toThrow(/missing\.json/u);
  });

  test('a task without a script or hidden verifier loads without them', async () => {
    const dir = await taskDir('fix-failing-test', {
      'repo/a.txt': 'a',
      'task.json': JSON.stringify(VALID),
    });
    const loaded = await loadEvalTask(dir);
    expect(loaded.script).toBeUndefined();
    expect(loaded.verifyDir).toBeUndefined();
  });
});

test('every committed task decodes, with a scripted-mode script', async () => {
  const tasks = await loadEvalTasks(resolve(import.meta.dirname, '../tasks'));
  expect(tasks.length).toBeGreaterThanOrEqual(5);
  for (const loaded of tasks) {
    expect(loaded.script, `${loaded.task.id} has a scripted-mode script`).toBeDefined();
  }
});
