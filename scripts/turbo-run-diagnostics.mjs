#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findLatestTurboSummary, findTurboSummaries, formatDuration } from './ci-timing-summary.mjs';

const DEFAULT_RUNS_DIR = '.turbo/runs';
const DEFAULT_TASK = 'test:coverage';
const DEFAULT_TOP_LIMIT = 10;

function readFlagValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  if (args.indexOf(name, index + 1) !== -1) {
    throw new Error(`${name} can only be provided once`);
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith('-')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function asPositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readExecutionMs(task) {
  const startTime = task?.execution?.startTime;
  const endTime = task?.execution?.endTime;
  if (!(typeof startTime === 'number' && typeof endTime === 'number')) {
    return null;
  }
  return endTime >= startTime ? endTime - startTime : null;
}

function readTaskId(task) {
  return String(task.taskId ?? `${task.package ?? 'unknown'}#${task.task ?? 'unknown'}`);
}

function readCacheStatus(task) {
  return String(task.cache?.status ?? 'UNKNOWN');
}

function summarizeCache(tasks) {
  const counts = new Map();
  for (const task of tasks) {
    const status = readCacheStatus(task);
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function collectPackages(tasks) {
  return [
    ...new Set(
      tasks
        .map((task) => task?.package)
        .filter((packageName) => typeof packageName === 'string' && packageName.length > 0)
    ),
  ].sort();
}

function countTaskInputs(task) {
  const inputs = task?.inputs;
  if (Array.isArray(inputs)) {
    return inputs.length;
  }
  if (inputs && typeof inputs === 'object') {
    return Object.keys(inputs).length;
  }
  return 0;
}

function collectGlobalInputs(summaryJson, limit) {
  const candidates = [];
  const globalHashInputs = summaryJson?.globalHashInputs;
  if (globalHashInputs && typeof globalHashInputs === 'object') {
    for (const [key, value] of Object.entries(globalHashInputs)) {
      candidates.push([key, summarizeGlobalInput(value)]);
    }
  }

  const globalFileHashMap = summaryJson?.globalCacheInputs?.files ?? summaryJson?.globalHashSummary;
  if (globalFileHashMap && typeof globalFileHashMap === 'object') {
    for (const key of Object.keys(globalFileHashMap)) {
      candidates.push([key, 'file input']);
    }
  }

  return candidates.slice(0, limit);
}

function summarizeGlobalInput(value) {
  if (Array.isArray(value)) {
    return `${value.length} entries`;
  }
  if (value && typeof value === 'object') {
    return `${Object.keys(value).length} keys`;
  }
  return String(value);
}

export function parseTurboDiagnostics(summaryJson, options = {}) {
  const taskName = options.task ?? DEFAULT_TASK;
  const taskPrefix = options.taskPrefix;
  const taskLabel =
    typeof taskPrefix === 'string' && taskPrefix.length > 0 ? `${taskPrefix}*` : taskName;
  const topLimit = asPositiveInteger(options.top, DEFAULT_TOP_LIMIT);
  const allTasks = Array.isArray(summaryJson?.tasks) ? summaryJson.tasks : [];
  const selectedTasks = allTasks.filter((task) => {
    const currentTask = String(task?.task ?? '');
    return typeof taskPrefix === 'string' && taskPrefix.length > 0
      ? currentTask.startsWith(taskPrefix)
      : currentTask === taskName;
  });
  const packages = collectPackages(selectedTasks);
  const slowestTasks = selectedTasks
    .map((task) => ({
      taskId: readTaskId(task),
      durationMs: readExecutionMs(task),
      cacheStatus: readCacheStatus(task),
    }))
    .filter((task) => typeof task.durationMs === 'number')
    .sort((left, right) => right.durationMs - left.durationMs)
    .slice(0, topLimit);
  const inputCounts = selectedTasks
    .map((task) => ({
      taskId: readTaskId(task),
      inputCount: countTaskInputs(task),
      cacheStatus: readCacheStatus(task),
    }))
    .filter((task) => task.inputCount > 0)
    .sort((left, right) => right.inputCount - left.inputCount)
    .slice(0, topLimit);

  return {
    command: String(summaryJson?.execution?.command ?? 'unknown'),
    task: taskLabel,
    totalTasks: selectedTasks.length,
    packages,
    cacheCounts: summarizeCache(selectedTasks),
    slowestTasks,
    inputCounts,
    globalInputs: collectGlobalInputs(summaryJson, topLimit),
  };
}

function combineSummaries(summaries) {
  if (summaries.length === 1) {
    return summaries[0];
  }
  return {
    execution: {
      command: summaries
        .map((summary) => String(summary?.execution?.command ?? 'unknown'))
        .join(' && '),
    },
    globalCacheInputs: summaries[0]?.globalCacheInputs,
    globalHashInputs: summaries[0]?.globalHashInputs,
    tasks: summaries.flatMap((summary) => (Array.isArray(summary?.tasks) ? summary.tasks : [])),
  };
}

export function renderMarkdownDiagnostics(diagnostics) {
  const lines = [
    `## Turbo ${diagnostics.task} Diagnostics`,
    '',
    `Command: \`${diagnostics.command}\``,
    `Selected tasks: ${diagnostics.totalTasks}`,
    `Selected packages: ${diagnostics.packages.length}`,
  ];

  if (diagnostics.packages.length > 0) {
    lines.push('', diagnostics.packages.map((packageName) => `\`${packageName}\``).join(', '));
  }

  lines.push('', '| Cache | Tasks |', '|---|---:|');
  if (diagnostics.cacheCounts.length === 0) {
    lines.push('| none | 0 |');
  } else {
    for (const [status, count] of diagnostics.cacheCounts) {
      lines.push(`| ${status} | ${count} |`);
    }
  }

  lines.push('', '### Slowest Tasks', '', '| Task | Duration | Cache |', '|---|---:|---|');
  if (diagnostics.slowestTasks.length === 0) {
    lines.push('| none | - | - |');
  } else {
    for (const task of diagnostics.slowestTasks) {
      lines.push(`| \`${task.taskId}\` | ${formatDuration(task.durationMs)} | ${task.cacheStatus} |`);
    }
  }

  lines.push('', '### Largest Task Input Sets', '', '| Task | Inputs | Cache |', '|---|---:|---|');
  if (diagnostics.inputCounts.length === 0) {
    lines.push('| unavailable | - | - |');
  } else {
    for (const task of diagnostics.inputCounts) {
      lines.push(`| \`${task.taskId}\` | ${task.inputCount} | ${task.cacheStatus} |`);
    }
  }

  lines.push('', '### Global Hash Inputs', '', '| Input | Detail |', '|---|---|');
  if (diagnostics.globalInputs.length === 0) {
    lines.push('| unavailable | Summary did not expose global hash input details |');
  } else {
    for (const [input, detail] of diagnostics.globalInputs) {
      lines.push(`| \`${input}\` | ${detail} |`);
    }
  }

  return lines.join('\n');
}

export async function runCli(args = process.argv.slice(2)) {
  let runsDir;
  let explicitSummary;
  let output;
  let task;
  let taskPrefix;
  let top;
  let allSummaries;
  try {
    runsDir = readFlagValue(args, '--runs-dir') ?? DEFAULT_RUNS_DIR;
    explicitSummary = readFlagValue(args, '--summary');
    output = readFlagValue(args, '--output');
    task = readFlagValue(args, '--task') ?? DEFAULT_TASK;
    taskPrefix = readFlagValue(args, '--task-prefix');
    top = asPositiveInteger(readFlagValue(args, '--top'), DEFAULT_TOP_LIMIT);
    allSummaries = args.includes('--all');
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

  const markdown = renderMarkdownDiagnostics(
    parseTurboDiagnostics(combineSummaries(summaries), { task, taskPrefix, top })
  );
  if (output) {
    await writeFile(output, `${markdown}\n`);
  } else {
    console.log(markdown);
  }
  return 0;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath === modulePath) {
  const exitCode = await runCli();
  process.exit(exitCode);
}
