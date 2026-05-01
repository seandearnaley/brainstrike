import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  parseTurboDiagnostics,
  renderMarkdownDiagnostics,
  runCli,
} from '../turbo-run-diagnostics.mjs';

function task(taskId, taskName, startTime, endTime, status = 'MISS', inputCount = 0) {
  const inputs = Object.fromEntries(
    Array.from({ length: inputCount }, (_, index) => [`src/file-${index}.ts`, 'hash'])
  );
  return {
    taskId,
    task: taskName,
    package: taskId.split('#')[0],
    cache: { status },
    execution: { startTime, endTime, exitCode: 0 },
    inputs,
  };
}

test('parseTurboDiagnostics summarizes selected task cache and package data', () => {
  const diagnostics = parseTurboDiagnostics(
    {
      execution: { command: 'turbo run test:coverage' },
      globalHashInputs: {
        files: ['pnpm-lock.yaml', 'turbo.jsonc'],
      },
      tasks: [
        task('@brainstrike/web#test:coverage', 'test:coverage', 1_000, 4_000, 'HIT', 2),
        task('@brainstrike/db#test:coverage', 'test:coverage', 1_000, 9_000, 'MISS', 4),
        task('@brainstrike/db#build', 'build', 1_000, 2_000, 'HIT', 1),
      ],
    },
    { task: 'test:coverage', top: 5 }
  );

  assert.deepEqual(diagnostics.packages, ['@brainstrike/db', '@brainstrike/web']);
  assert.deepEqual(diagnostics.cacheCounts, [
    ['HIT', 1],
    ['MISS', 1],
  ]);
  assert.deepEqual(
    diagnostics.slowestTasks.map((entry) => entry.taskId),
    ['@brainstrike/db#test:coverage', '@brainstrike/web#test:coverage']
  );
  assert.equal(diagnostics.inputCounts[0].inputCount, 4);
});

test('renderMarkdownDiagnostics includes cache, slow task, and hash sections', () => {
  const markdown = renderMarkdownDiagnostics(
    parseTurboDiagnostics(
      {
        execution: { command: 'turbo run test:coverage' },
        tasks: [task('@brainstrike/db#test:coverage', 'test:coverage', 1_000, 61_000, 'MISS', 3)],
      },
      { task: 'test:coverage' }
    )
  );

  assert.match(markdown, /## Turbo test:coverage Diagnostics/);
  assert.match(markdown, /### Slowest Tasks/);
  assert.match(markdown, /@brainstrike\/db#test:coverage/);
  assert.match(markdown, /### Global Hash Inputs/);
});

test('runCli writes diagnostics markdown', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'brainstrike-turbo-diagnostics-'));
  try {
    const summaryPath = path.join(dir, 'summary.json');
    const outputPath = path.join(dir, 'diagnostics.md');
    await writeFile(
      summaryPath,
      JSON.stringify({
        execution: { command: 'turbo run test:coverage' },
        tasks: [task('@brainstrike/db#test:coverage', 'test:coverage', 1_000, 2_000)],
      })
    );

    const exitCode = await runCli([
      '--summary',
      summaryPath,
      '--task',
      'test:coverage',
      '--output',
      outputPath,
    ]);

    assert.equal(exitCode, 0);
    assert.match(await readFile(outputPath, 'utf8'), /Turbo test:coverage Diagnostics/);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('runCli rejects duplicate flags', async () => {
  const originalConsoleError = console.error;
  const errors = [];
  console.error = (message) => {
    errors.push(String(message));
  };
  try {
    const exitCode = await runCli(['--task', 'test', '--task', 'build']);

    assert.equal(exitCode, 1);
    assert.match(errors.join('\n'), /--task can only be provided once/);
  } finally {
    console.error = originalConsoleError;
  }
});
