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
  return {
    task: options.task ?? DEFAULT_TASK,
    warnMs: asNumber(options.warnMs, DEFAULT_WARN_MS),
    failMs: asNumber(options.failMs, DEFAULT_FAIL_MS),
    totalWarnMs: asNumber(options.totalWarnMs, options.warnMs ?? DEFAULT_WARN_MS),
    totalFailMs: asNumber(options.totalFailMs, options.failMs ?? DEFAULT_FAIL_MS),
  };
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

export function formatDuration(ms) {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function parseTurboSummary(summaryJson, options = {}) {
  const resolvedOptions = normalizeOptions(options);
  const tasks = Array.isArray(summaryJson?.tasks) ? summaryJson.tasks : [];
  const parsedTasks = tasks
    .filter((task) => task?.task === resolvedOptions.task)
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
    task: resolvedOptions.task,
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

function markdownStatus(status) {
  if (status === 'fail') {
    return 'fail';
  }
  if (status === 'warn') {
    return 'warn';
  }
  return 'ok';
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
      `| \`${task.taskId}\` | ${formatDuration(task.durationMs)} | ${task.cacheStatus} | ${markdownStatus(task.status)} |`
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
  const entries = await readdir(runsDir, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!(entry.isFile() && entry.name.endsWith('.json'))) {
      continue;
    }
    const filePath = path.join(runsDir, entry.name);
    const fileStat = await stat(filePath);
    candidates.push({ filePath, mtimeMs: fileStat.mtimeMs });
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0]?.filePath ?? null;
}

function readFlagValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

export async function runCli(args = process.argv.slice(2)) {
  const runsDir = readFlagValue(args, '--runs-dir') ?? DEFAULT_RUNS_DIR;
  const explicitSummary = readFlagValue(args, '--summary');
  const task = readFlagValue(args, '--task') ?? DEFAULT_TASK;
  const warnMs = asNumber(readFlagValue(args, '--warn-ms'), DEFAULT_WARN_MS);
  const failMs = asNumber(readFlagValue(args, '--fail-ms'), DEFAULT_FAIL_MS);
  const totalWarnMs = asNumber(readFlagValue(args, '--total-warn-ms'), warnMs);
  const totalFailMs = asNumber(readFlagValue(args, '--total-fail-ms'), failMs);
  const output = readFlagValue(args, '--output');
  const summaryPath = explicitSummary ?? (await findLatestTurboSummary(runsDir));

  if (!summaryPath) {
    console.error(`No Turbo run summary JSON found in ${runsDir}`);
    return 1;
  }

  const summaryJson = JSON.parse(await readFile(summaryPath, 'utf8'));
  const summary = parseTurboSummary(summaryJson, { task, warnMs, failMs, totalWarnMs, totalFailMs });
  const markdown = renderMarkdownSummary(summary);
  const annotations = renderGitHubAnnotations(summary);

  if (output) {
    await writeFile(output, `${markdown}\n`);
  } else {
    console.log(markdown);
  }
  if (annotations) {
    console.error(annotations);
  }

  return summary.hasFailures || summary.tasks.length === 0 ? 1 : 0;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath === modulePath) {
  const exitCode = await runCli();
  process.exit(exitCode);
}
