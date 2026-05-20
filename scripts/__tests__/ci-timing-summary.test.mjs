import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  findLatestTurboSummary,
  formatDuration,
  parseTurboSummary,
  renderGitHubAnnotations,
  renderMarkdownSummary,
  renderTimingBudgetJson,
  runCli,
} from '../ci-timing-summary.mjs';

function task(taskId, taskName, startTime, endTime, status = 'MISS') {
  return {
    taskId,
    task: taskName,
    package: taskId.split('#')[0],
    cache: {
      status,
    },
    execution: {
      startTime,
      endTime,
      exitCode: 0,
    },
  };
}

test('formatDuration renders compact seconds and minutes', () => {
  assert.equal(formatDuration(999), '999ms');
  assert.equal(formatDuration(12_345), '12.3s');
  assert.equal(formatDuration(185_000), '3m 5s');
  assert.equal(formatDuration(119_500), '2m 0s');
});

test('parseTurboSummary sorts task timings and flags threshold breaches', () => {
  const summary = parseTurboSummary(
    {
      execution: {
        command: 'turbo run test',
        startTime: 1_000,
        endTime: 190_000,
        success: true,
      },
      tasks: [
        task('@brainstrike/fast#test', 'test', 5_000, 7_000, 'HIT'),
        task('@brainstrike/db#test', 'test', 10_000, 190_000),
        task('@brainstrike/web#build', 'build', 1_000, 2_500),
      ],
    },
    { task: 'test', warnMs: 30_000, failMs: 120_000 }
  );

  assert.deepEqual(
    summary.tasks.map((entry) => entry.taskId),
    ['@brainstrike/db#test', '@brainstrike/fast#test']
  );
  assert.equal(summary.tasks[0].durationMs, 180_000);
  assert.equal(summary.tasks[0].status, 'fail');
  assert.equal(summary.tasks[1].cacheStatus, 'HIT');
  assert.equal(summary.hasFailures, true);
});

test('parseTurboSummary flags total Turbo time threshold breaches', () => {
  const summary = parseTurboSummary(
    {
      execution: {
        command: 'turbo run test',
        startTime: 1_000,
        endTime: 181_000,
        success: true,
      },
      tasks: [task('@brainstrike/db#test', 'test', 1_000, 2_000)],
    },
    { task: 'test', totalFailMs: 120_000 }
  );

  assert.equal(summary.totalStatus, 'fail');
  assert.equal(summary.hasFailures, true);
});

test('parseTurboSummary coerces total threshold fallbacks from task thresholds', () => {
  const summary = parseTurboSummary(
    {
      execution: {
        command: 'turbo run test',
        startTime: 1_000,
        endTime: 31_000,
        success: true,
      },
      tasks: [task('@brainstrike/db#test', 'test', 1_000, 2_000)],
    },
    { task: 'test', warnMs: '20000', failMs: '30000' }
  );

  assert.equal(summary.totalWarnMs, 20_000);
  assert.equal(summary.totalFailMs, 30_000);
  assert.equal(summary.totalStatus, 'fail');
});

test('renderMarkdownSummary includes slowest tasks without workflow commands', () => {
  const summary = parseTurboSummary(
    {
      execution: {
        command: 'turbo run test',
        startTime: 1_000,
        endTime: 190_000,
        success: true,
      },
      tasks: [task('@brainstrike/db#test', 'test', 10_000, 190_000)],
    },
    { task: 'test', warnMs: 30_000, failMs: 120_000 }
  );

  const markdown = renderMarkdownSummary(summary);

  assert.match(markdown, /## Turbo test Task Durations/);
  assert.match(markdown, /@brainstrike\/db#test/);
  assert.doesNotMatch(markdown, /::error/);
});

test('renderGitHubAnnotations reports total and task threshold breaches', () => {
  const summary = parseTurboSummary(
    {
      execution: {
        command: 'turbo run test',
        startTime: 1_000,
        endTime: 181_000,
        success: true,
      },
      tasks: [task('@brainstrike/db#test', 'test', 1_000, 181_000)],
    },
    { task: 'test', failMs: 120_000, totalFailMs: 120_000 }
  );

  const annotations = renderGitHubAnnotations(summary);

  assert.match(renderMarkdownSummary(summary), /Total Turbo time: 3m 0s \(fail\)/);
  assert.match(annotations, /::error title=Slow Turbo run::turbo run test took 3m 0s/);
  assert.match(annotations, /::error title=Slow Turbo task::@brainstrike\/db#test took 3m 0s/);
});

test('renderTimingBudgetJson emits machine-readable p50 and p95 timing data', () => {
  const summary = parseTurboSummary(
    {
      execution: {
        command: 'turbo run test',
        startTime: 1_000,
        endTime: 21_000,
        success: true,
      },
      tasks: [
        task('@brainstrike/a#test', 'test', 1_000, 2_000),
        task('@brainstrike/b#test', 'test', 1_000, 6_000),
        task('@brainstrike/c#test', 'test', 1_000, 21_000),
      ],
    },
    { task: 'test', warnMs: 10_000, failMs: 30_000 }
  );

  const parsed = JSON.parse(renderTimingBudgetJson(summary, { calibration: true }));

  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.calibration, true);
  assert.equal(parsed.totals.taskCount, 3);
  assert.equal(parsed.totals.p50TaskMs, 5_000);
  assert.equal(parsed.totals.p95TaskMs, 20_000);
  assert.equal(parsed.totals.maxTaskMs, 20_000);
  assert.equal(parsed.status.exitWouldFailOutsideCalibration, false);
  assert.deepEqual(
    parsed.slowestTasks.map((entry) => entry.taskId),
    ['@brainstrike/c#test', '@brainstrike/b#test', '@brainstrike/a#test']
  );
});

test('findLatestTurboSummary returns the newest JSON file', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'brainstrike-turbo-runs-'));
  try {
    const older = path.join(dir, 'older.json');
    const newer = path.join(dir, 'newer.json');
    await writeFile(older, '{}');
    await writeFile(newer, '{}');
    await utimes(older, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
    await utimes(newer, new Date('2026-01-01T00:00:10Z'), new Date('2026-01-01T00:00:10Z'));

    assert.equal(await findLatestTurboSummary(dir), newer);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('findLatestTurboSummary returns null when the runs directory is missing', async () => {
  const dir = path.join(tmpdir(), `brainstrike-missing-runs-${Date.now()}`);

  assert.equal(await findLatestTurboSummary(dir), null);
});

test('runCli writes markdown and returns non-zero when fail threshold is crossed', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'brainstrike-turbo-cli-'));
  const originalConsoleError = console.error;
  const originalConsoleLog = console.log;
  const logs = [];
  console.error = () => {};
  console.log = (message) => {
    logs.push(String(message));
  };
  try {
    const summaryPath = path.join(dir, 'summary.json');
    const outputPath = path.join(dir, 'summary.md');
    await writeFile(
      summaryPath,
      JSON.stringify({
        execution: {
          command: 'turbo run test',
          startTime: 1_000,
          endTime: 190_000,
          success: true,
        },
        tasks: [task('@brainstrike/db#test', 'test', 10_000, 190_000)],
      })
    );

    const exitCode = await runCli([
      '--summary',
      summaryPath,
      '--task',
      'test',
      '--warn-ms',
      '30000',
      '--fail-ms',
      '120000',
      '--output',
      outputPath,
    ]);

    assert.equal(exitCode, 1);
    const markdown = await readFile(outputPath, 'utf8');
    assert.match(markdown, /@brainstrike\/db#test/);
    assert.doesNotMatch(markdown, /::error/);
    assert.match(logs.join('\n'), /::error title=Slow Turbo task::@brainstrike\/db#test/);
  } finally {
    console.error = originalConsoleError;
    console.log = originalConsoleLog;
    await rm(dir, { force: true, recursive: true });
  }
});

test('runCli writes timing JSON and calibration mode does not fail slow budgets', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'brainstrike-turbo-cli-json-'));
  try {
    const summaryPath = path.join(dir, 'summary.json');
    const outputPath = path.join(dir, 'summary.md');
    const jsonOutputPath = path.join(dir, 'summary.json.out');
    await writeFile(
      summaryPath,
      JSON.stringify({
        execution: {
          command: 'turbo run test',
          startTime: 1_000,
          endTime: 181_000,
          success: true,
        },
        tasks: [task('@brainstrike/db#test', 'test', 1_000, 181_000)],
      })
    );

    const exitCode = await runCli([
      '--summary',
      summaryPath,
      '--task',
      'test',
      '--fail-ms',
      '120000',
      '--output',
      outputPath,
      '--json-output',
      jsonOutputPath,
      '--calibration',
    ]);

    assert.equal(exitCode, 0);
    const parsed = JSON.parse(await readFile(jsonOutputPath, 'utf8'));
    assert.equal(parsed.calibration, true);
    assert.equal(parsed.status.hasFailures, true);
    assert.equal(parsed.status.exitWouldFailOutsideCalibration, true);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('runCli returns non-zero when the summary has no matching task', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'brainstrike-turbo-cli-empty-'));
  try {
    const summaryPath = path.join(dir, 'summary.json');
    const outputPath = path.join(dir, 'summary.md');
    await writeFile(
      summaryPath,
      JSON.stringify({
        execution: {
          command: 'turbo run build',
          startTime: 1_000,
          endTime: 2_000,
          success: true,
        },
        tasks: [task('@brainstrike/db#build', 'build', 1_000, 2_000)],
      })
    );

    const exitCode = await runCli(['--summary', summaryPath, '--task', 'test', '--output', outputPath]);

    assert.equal(exitCode, 1);
    assert.match(await readFile(outputPath, 'utf8'), /No `test` tasks were found/);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('runCli allows a no-op Turbo run for the requested task', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'brainstrike-turbo-cli-noop-'));
  try {
    const summaryPath = path.join(dir, 'summary.json');
    const outputPath = path.join(dir, 'summary.md');
    await writeFile(
      summaryPath,
      JSON.stringify({
        execution: {
          command: 'turbo run test',
          startTime: 1_000,
          endTime: 2_000,
          success: true,
        },
        tasks: [],
      })
    );

    const exitCode = await runCli(['--summary', summaryPath, '--task', 'test', '--output', outputPath]);

    assert.equal(exitCode, 0);
    assert.match(await readFile(outputPath, 'utf8'), /No `test` tasks were found/);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('runCli can aggregate multiple Turbo summaries by task prefix', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'brainstrike-turbo-cli-all-'));
  try {
    const firstPath = path.join(dir, 'first.json');
    const secondPath = path.join(dir, 'second.json');
    const outputPath = path.join(dir, 'summary.md');
    await writeFile(
      firstPath,
      JSON.stringify({
        execution: {
          command: 'turbo run test:coverage',
          startTime: 1_000,
          endTime: 2_000,
          success: true,
        },
        tasks: [task('@brainstrike/web#test:coverage', 'test:coverage', 1_000, 2_000)],
      })
    );
    await writeFile(
      secondPath,
      JSON.stringify({
        execution: {
          command: 'turbo run test:coverage:db:queue',
          startTime: 3_000,
          endTime: 4_000,
          success: true,
        },
        tasks: [
          task(
            '@brainstrike/db#test:coverage:db:queue',
            'test:coverage:db:queue',
            3_000,
            4_000
          ),
        ],
      })
    );

    const exitCode = await runCli([
      '--runs-dir',
      dir,
      '--all',
      '--task-prefix',
      'test:coverage',
      '--output',
      outputPath,
    ]);

    assert.equal(exitCode, 0);
    const markdown = await readFile(outputPath, 'utf8');
    assert.match(markdown, /Turbo test:coverage\* Task Durations/);
    assert.match(markdown, /@brainstrike\/web#test:coverage/);
    assert.match(markdown, /@brainstrike\/db#test:coverage:db:queue/);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('runCli reports the summary path when JSON parsing fails', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'brainstrike-turbo-cli-invalid-'));
  const originalConsoleError = console.error;
  const errors = [];
  console.error = (message) => {
    errors.push(String(message));
  };
  try {
    const summaryPath = path.join(dir, 'summary.json');
    await writeFile(summaryPath, '{not valid json');

    const exitCode = await runCli(['--summary', summaryPath, '--task', 'test']);

    assert.equal(exitCode, 1);
    assert.match(errors.join('\n'), new RegExp(summaryPath.replaceAll('/', '\\/')));
  } finally {
    console.error = originalConsoleError;
    await rm(dir, { force: true, recursive: true });
  }
});

test('runCli rejects flags without explicit values', async () => {
  const originalConsoleError = console.error;
  const errors = [];
  console.error = (message) => {
    errors.push(String(message));
  };
  try {
    const exitCode = await runCli(['--summary', '--task', 'test']);

    assert.equal(exitCode, 1);
    assert.match(errors.join('\n'), /--summary requires a value/);

    errors.length = 0;
    const singleDashExitCode = await runCli(['--summary', '-o']);

    assert.equal(singleDashExitCode, 1);
    assert.match(errors.join('\n'), /--summary requires a value/);
  } finally {
    console.error = originalConsoleError;
  }
});

test('runCli reports output write failures', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'brainstrike-turbo-cli-output-'));
  const originalConsoleError = console.error;
  const errors = [];
  console.error = (message) => {
    errors.push(String(message));
  };
  try {
    const summaryPath = path.join(dir, 'summary.json');
    const outputPath = path.join(dir, 'missing', 'summary.md');
    await writeFile(
      summaryPath,
      JSON.stringify({
        execution: {
          command: 'turbo run test',
          startTime: 1_000,
          endTime: 2_000,
          success: true,
        },
        tasks: [task('@brainstrike/db#test', 'test', 1_000, 2_000)],
      })
    );

    const exitCode = await runCli(['--summary', summaryPath, '--task', 'test', '--output', outputPath]);

    assert.equal(exitCode, 1);
    assert.match(errors.join('\n'), new RegExp(outputPath.replaceAll('/', '\\/')));
  } finally {
    console.error = originalConsoleError;
    await rm(dir, { force: true, recursive: true });
  }
});
