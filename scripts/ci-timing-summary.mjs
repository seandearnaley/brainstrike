#!/usr/bin/env node

import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_RUNS_DIR = '.turbo/runs';
const DEFAULT_TASK = 'test';
const DEFAULT_WARN_MS = 20 * 60 * 1000;
const DEFAULT_FAIL_MS = 30 * 60 * 1000;

function asNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeOptions(options = {}) {
  const warnMs = asNumber(options.warnMs, DEFAULT_WARN_MS);
  const failMs = asNumber(options.failMs, DEFAULT_FAIL_MS);
  return {
    task: options.task ?? DEFAULT_TASK,
    taskPrefix: options.taskPrefix,
    warnMs,
    failMs,
    totalWarnMs: asNumber(options.totalWarnMs, warnMs),
    totalFailMs: asNumber(options.totalFailMs, failMs),
  };
}

function matchesTask(task, options) {
  const taskName = String(task?.task ?? '');
  if (typeof options.taskPrefix === 'string' && options.taskPrefix.length > 0) {
    return taskName.startsWith(options.taskPrefix);
  }
  return taskName === options.task;
}

function taskLabel(options) {
  return typeof options.taskPrefix === 'string' && options.taskPrefix.length > 0
    ? `${options.taskPrefix}*`
    : options.task;
}

function readExecutionMs(task) {
  const startTime = task?.execution?.startTime;
  const endTime = task?.execution?.endTime;
  if (!(typeof startTime === 'number' && typeof endTime === 'number')) {
    return null;
  }
  if (endTime < startTime) {
    return null;
  }
  return endTime - startTime;
}

function classifyDuration(durationMs, warnMs, failMs) {
  if (durationMs >= failMs) {
    return 'fail';
  }
  if (durationMs >= warnMs) {
    return 'warn';
  }
  return 'ok';
}

function nearestRank(values, percentile) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil((percentile / 100) * sorted.length);
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank - 1))];
}

export function formatDuration(ms) {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

export function renderTimingBudgetJson(summary, options = {}) {
  const durations = summary.tasks.map((task) => task.durationMs);
  const slowestTasks = summary.tasks.slice(0, options.slowestLimit ?? 10).map((task) => ({
    taskId: task.taskId,
    packageName: task.packageName,
    task: task.task,
    durationMs: task.durationMs,
    cacheStatus: task.cacheStatus,
    status: task.status,
  }));
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      calibration: options.calibration === true,
      command: summary.command,
      task: summary.task,
      budget: {
        taskWarnMs: summary.warnMs,
        taskFailMs: summary.failMs,
        totalWarnMs: summary.totalWarnMs,
        totalFailMs: summary.totalFailMs,
      },
      totals: {
        durationMs: summary.executionDurationMs,
        status: summary.totalStatus,
        taskCount: summary.tasks.length,
        p50TaskMs: nearestRank(durations, 50),
        p95TaskMs: nearestRank(durations, 95),
        maxTaskMs: durations[0] ?? null,
      },
      status: {
        hasFailures: summary.hasFailures,
        hasWarnings: summary.hasWarnings,
        exitWouldFailOutsideCalibration: summary.hasFailures,
      },
      slowestTasks,
    },
    null,
    2
  )}\n`;
}

export function parseTurboSummary(summaryJson, options = {}) {
  const resolvedOptions = normalizeOptions(options);
  const tasks = Array.isArray(summaryJson?.tasks) ? summaryJson.tasks : [];
  const parsedTasks = tasks
    .filter((task) => matchesTask(task, resolvedOptions))
    .map((task) => {
      const durationMs = readExecutionMs(task);
      if (durationMs === null) {
        return null;
      }
      return {
        taskId: String(task.taskId ?? `${task.package ?? 'unknown'}#${task.task ?? 'unknown'}`),
        packageName: String(task.package ?? 'unknown'),
        task: String(task.task ?? 'unknown'),
        cacheStatus: String(task.cache?.status ?? 'UNKNOWN'),
        durationMs,
        status: classifyDuration(durationMs, resolvedOptions.warnMs, resolvedOptions.failMs),
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.durationMs - left.durationMs);

  const executionDurationMs =
    typeof summaryJson?.execution?.startTime === 'number' &&
    typeof summaryJson?.execution?.endTime === 'number'
      ? summaryJson.execution.endTime - summaryJson.execution.startTime
      : null;
  const totalStatus =
    executionDurationMs === null
      ? 'unknown'
      : classifyDuration(
          executionDurationMs,
          resolvedOptions.totalWarnMs,
          resolvedOptions.totalFailMs
        );

  return {
    command: String(summaryJson?.execution?.command ?? 'unknown'),
    task: taskLabel(resolvedOptions),
    warnMs: resolvedOptions.warnMs,
    failMs: resolvedOptions.failMs,
    totalWarnMs: resolvedOptions.totalWarnMs,
    totalFailMs: resolvedOptions.totalFailMs,
    executionDurationMs,
    totalStatus,
    tasks: parsedTasks,
    hasFailures: totalStatus === 'fail' || parsedTasks.some((task) => task.status === 'fail'),
    hasWarnings: totalStatus === 'warn' || parsedTasks.some((task) => task.status === 'warn'),
  };
}

export function renderMarkdownSummary(summary) {
  const lines = [
    `## Turbo ${summary.task} Task Durations`,
    '',
    `Command: \`${summary.command}\``,
    `Warn threshold: ${formatDuration(summary.warnMs)} | Fail threshold: ${formatDuration(summary.failMs)}`,
    `Total warn threshold: ${formatDuration(summary.totalWarnMs)} | Total fail threshold: ${formatDuration(summary.totalFailMs)}`,
  ];

  if (typeof summary.executionDurationMs === 'number') {
    lines.push(
      `Total Turbo time: ${formatDuration(summary.executionDurationMs)} (${summary.totalStatus})`
    );
  }

  if (summary.tasks.length === 0) {
    lines.push('', `No \`${summary.task}\` tasks were found in the Turbo summary.`);
    return lines.join('\n');
  }

  lines.push('', '| Task | Duration | Cache | Status |', '|---|---:|---|---|');
  for (const task of summary.tasks) {
    lines.push(
      `| \`${task.taskId}\` | ${formatDuration(task.durationMs)} | ${task.cacheStatus} | ${task.status} |`
    );
  }

  return lines.join('\n');
}

export function renderGitHubAnnotations(summary) {
  const lines = [];
  if (typeof summary.executionDurationMs === 'number' && summary.totalStatus !== 'ok') {
    const annotation = summary.totalStatus === 'fail' ? 'error' : 'warning';
    const title = summary.totalStatus === 'fail' ? 'Slow Turbo run' : 'Elevated Turbo run duration';
    lines.push(
      `::${annotation} title=${title}::${summary.command} took ${formatDuration(summary.executionDurationMs)}`
    );
  }

  for (const task of summary.tasks.filter((entry) => entry.status !== 'ok')) {
    const annotation = task.status === 'fail' ? 'error' : 'warning';
    const title = task.status === 'fail' ? 'Slow Turbo task' : 'Elevated Turbo task duration';
    lines.push(
      `::${annotation} title=${title}::${task.taskId} took ${formatDuration(task.durationMs)}`
    );
  }

  return lines.join('\n');
}

export async function findLatestTurboSummary(runsDir = DEFAULT_RUNS_DIR) {
  let entries;
  try {
    entries = await readdir(runsDir, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map(async (entry) => {
        const filePath = path.join(runsDir, entry.name);
        const fileStat = await stat(filePath);
        return { filePath, mtimeMs: fileStat.mtimeMs };
      })
  );
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0]?.filePath ?? null;
}

export async function findTurboSummaries(runsDir = DEFAULT_RUNS_DIR) {
  let entries;
  try {
    entries = await readdir(runsDir, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map(async (entry) => {
        const filePath = path.join(runsDir, entry.name);
        const fileStat = await stat(filePath);
        return { filePath, mtimeMs: fileStat.mtimeMs };
      })
  );
  return candidates.sort((left, right) => left.mtimeMs - right.mtimeMs).map((entry) => entry.filePath);
}

function readFlagValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith('-')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function commandIncludesTask(command, task) {
  return command.split(/\s+/).includes(task);
}

function commandIncludesTaskPrefix(command, taskPrefix) {
  return command.split(/\s+/).some((token) => token.startsWith(taskPrefix));
}

function combineSummaries(summaries) {
  if (summaries.length === 1) {
    return summaries[0];
  }
  const startTimes = summaries
    .map((summary) => summary?.execution?.startTime)
    .filter((value) => typeof value === 'number');
  const endTimes = summaries
    .map((summary) => summary?.execution?.endTime)
    .filter((value) => typeof value === 'number');
  return {
    execution: {
      command: summaries
        .map((summary) => String(summary?.execution?.command ?? 'unknown'))
        .join(' && '),
      startTime: startTimes.length > 0 ? Math.min(...startTimes) : undefined,
      endTime: endTimes.length > 0 ? Math.max(...endTimes) : undefined,
    },
    tasks: summaries.flatMap((summary) => (Array.isArray(summary?.tasks) ? summary.tasks : [])),
  };
}

export async function runCli(args = process.argv.slice(2)) {
  let runsDir;
  let explicitSummary;
  let task;
  let taskPrefix;
  let warnMs;
  let failMs;
  let totalWarnMs;
  let totalFailMs;
  let output;
  let jsonOutput;
  let allSummaries;
  let calibration;
  try {
    runsDir = readFlagValue(args, '--runs-dir') ?? DEFAULT_RUNS_DIR;
    explicitSummary = readFlagValue(args, '--summary');
    task = readFlagValue(args, '--task') ?? DEFAULT_TASK;
    taskPrefix = readFlagValue(args, '--task-prefix');
    warnMs = asNumber(readFlagValue(args, '--warn-ms'), DEFAULT_WARN_MS);
    failMs = asNumber(readFlagValue(args, '--fail-ms'), DEFAULT_FAIL_MS);
    totalWarnMs = asNumber(readFlagValue(args, '--total-warn-ms'), warnMs);
    totalFailMs = asNumber(readFlagValue(args, '--total-fail-ms'), failMs);
    output = readFlagValue(args, '--output');
    jsonOutput = readFlagValue(args, '--json-output');
    allSummaries = args.includes('--all');
    calibration = args.includes('--calibration');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    return 1;
  }
  const summaryPaths = explicitSummary
    ? [explicitSummary]
    : allSummaries
      ? await findTurboSummaries(runsDir)
      : [await findLatestTurboSummary(runsDir)].filter(Boolean);

  if (summaryPaths.length === 0) {
    console.error(`No Turbo run summary JSON found in ${runsDir}`);
    return 1;
  }

  const summaries = [];
  for (const summaryPath of summaryPaths) {
    try {
      summaries.push(JSON.parse(await readFile(summaryPath, 'utf8')));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to parse Turbo summary JSON at ${summaryPath}: ${message}`);
      return 1;
    }
  }
  const summary = parseTurboSummary(combineSummaries(summaries), {
    task,
    taskPrefix,
    warnMs,
    failMs,
    totalWarnMs,
    totalFailMs,
  });
  const markdown = renderMarkdownSummary(summary);
  const timingJson = renderTimingBudgetJson(summary, { calibration });
  const annotations = renderGitHubAnnotations(summary);

  if (output) {
    try {
      await writeFile(output, `${markdown}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to write Turbo timing summary to ${output}: ${message}`);
      return 1;
    }
  } else {
    console.log(markdown);
  }
  if (annotations) {
    console.log(annotations);
  }
  if (jsonOutput) {
    try {
      await writeFile(jsonOutput, timingJson);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to write Turbo timing JSON to ${jsonOutput}: ${message}`);
      return 1;
    }
  }

  const noMatchingTasksFromDifferentCommand =
    summary.tasks.length === 0 &&
    !(taskPrefix ? commandIncludesTaskPrefix(summary.command, taskPrefix) : commandIncludesTask(summary.command, summary.task));
  if (noMatchingTasksFromDifferentCommand) {
    return 1;
  }
  return summary.hasFailures && !calibration ? 1 : 0;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath === modulePath) {
  const exitCode = await runCli();
  process.exit(exitCode);
}
