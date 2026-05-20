#!/usr/bin/env node

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LOCAL_PROOF_COMMANDS } from './ci-select.mjs';

function asPositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function formatDuration(ms) {
  if (ms === null) {
    return '-';
  }
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

function nearestRank(values, percentile) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil((percentile / 100) * sorted.length);
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank - 1))];
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readFlagValues(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) {
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('-')) {
      throw new Error(`${name} requires a value`);
    }
    values.push(value);
    index += 1;
  }
  return values;
}

function readFlagValue(args, name) {
  const values = readFlagValues(args, name);
  if (values.length > 1) {
    throw new Error(`${name} can only be provided once`);
  }
  return values[0];
}

export function parseCalibrationSummaryArgs(args = process.argv.slice(2)) {
  const normalizedArgs = args.filter((arg) => arg !== '--');
  const knownFlags = new Set(['--input', '--input-dir', '--min-samples', '--output', '--json-output']);
  for (let index = 0; index < normalizedArgs.length; index += 1) {
    const arg = normalizedArgs[index];
    if (!arg.startsWith('--')) {
      continue;
    }
    if (!knownFlags.has(arg)) {
      throw new Error(`unknown flag ${arg}`);
    }
    index += 1;
  }
  return {
    inputDirs: readFlagValues(normalizedArgs, '--input-dir'),
    inputPaths: readFlagValues(normalizedArgs, '--input'),
    jsonOutput: readFlagValue(normalizedArgs, '--json-output'),
    minSamples: asPositiveInteger(readFlagValue(normalizedArgs, '--min-samples'), 5),
    output: readFlagValue(normalizedArgs, '--output'),
  };
}

function readCalibrationCommandResult(result, sourcePath) {
  if (!isObject(result)) {
    throw new Error(`${sourcePath} command result must be an object`);
  }
  if (typeof result.name !== 'string' || result.name.length === 0) {
    throw new Error(`${sourcePath} command result name must be a string`);
  }
  if (typeof result.durationMs !== 'number') {
    throw new Error(`${sourcePath} command ${result.name} durationMs must be a number`);
  }
  if (typeof result.budgetMs !== 'number') {
    throw new Error(`${sourcePath} command ${result.name} budgetMs must be a number`);
  }
  if (typeof result.command !== 'string' || result.command.length === 0) {
    throw new Error(`${sourcePath} command ${result.name} command must be a string`);
  }
  if (typeof result.exitCode !== 'number') {
    throw new Error(`${sourcePath} command ${result.name} exitCode must be a number`);
  }
  const currentCommand = LOCAL_PROOF_COMMANDS[result.name];
  if (!currentCommand) {
    throw new Error(`${sourcePath} references unknown local proof command ${result.name}`);
  }
  return {
    command: currentCommand.command,
    currentBudgetMs: currentCommand.budgetMs,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    name: result.name,
    owner: currentCommand.owner,
    recordedCommand: result.command,
    recordedBudgetMs: result.budgetMs,
    requiredFor: currentCommand.requiredFor,
    sourcePath,
  };
}

function readCalibrationDocument(document, sourcePath) {
  if (!isObject(document)) {
    throw new Error(`${sourcePath} calibration document must be an object`);
  }
  if (document.schemaVersion !== 1) {
    throw new Error(`${sourcePath} calibration schemaVersion must be 1`);
  }
  if (!Array.isArray(document.commandResults)) {
    throw new Error(`${sourcePath} commandResults must be an array`);
  }
  return document.commandResults.map((result) => readCalibrationCommandResult(result, sourcePath));
}

function summarizeCommand(name, samples, minSamples) {
  const currentSamples = samples.filter(
    (sample) => sample.recordedCommand === sample.command
  );
  const staleCommandSampleCount = samples.length - currentSamples.length;
  const effectiveSamples = currentSamples.length > 0 ? currentSamples : samples;
  const durations = effectiveSamples.map((sample) => sample.durationMs);
  const p95Ms = nearestRank(durations, 95);
  const hasFailures = effectiveSamples.some((sample) => sample.exitCode !== 0);
  const latest = effectiveSamples[effectiveSamples.length - 1];
  const onlyStaleEvidence = currentSamples.length === 0 && staleCommandSampleCount > 0;
  const status = hasFailures
    ? 'failing'
    : onlyStaleEvidence
      ? 'stale-command'
      : effectiveSamples.length < minSamples
        ? 'calibrating'
        : p95Ms > latest.currentBudgetMs
          ? 'over-target'
          : 'within-target';
  return {
    name,
    owner: latest.owner,
    requiredFor: latest.requiredFor,
    sampleCount: effectiveSamples.length,
    p50Ms: nearestRank(durations, 50),
    p95Ms,
    currentBudgetMs: latest.currentBudgetMs,
    recordedBudgetMs: latest.recordedBudgetMs,
    recordedBudgetStale: latest.recordedBudgetMs !== latest.currentBudgetMs,
    recordedCommandStale: onlyStaleEvidence,
    ignoredStaleCommandSampleCount: currentSamples.length > 0 ? staleCommandSampleCount : 0,
    maxDurationMs: Math.max(...durations),
    failureCount: effectiveSamples.filter((sample) => sample.exitCode !== 0).length,
    staleCommandSampleCount: onlyStaleEvidence ? staleCommandSampleCount : 0,
    status,
    sources: effectiveSamples.map((sample) => sample.sourcePath),
  };
}

export function parseCalibrationSummary(calibrationDocuments, options = {}) {
  const minSamples = asPositiveInteger(options.minSamples, 5);
  const commandGroups = new Map();
  for (const { document, sourcePath } of calibrationDocuments) {
    for (const sample of readCalibrationDocument(document, sourcePath)) {
      commandGroups.set(sample.name, [...(commandGroups.get(sample.name) ?? []), sample]);
    }
  }
  const commands = [...commandGroups.entries()]
    .map(([name, samples]) => summarizeCommand(name, samples, minSamples))
    .sort((left, right) => left.name.localeCompare(right.name));
  return {
    schemaVersion: 1,
    generatedFrom: 'calibration-files',
    minSamples,
    sampleCount: calibrationDocuments.length,
    commandSampleCount: commands.reduce((sum, command) => sum + command.sampleCount, 0),
    status: commands.some((command) => command.status === 'failing')
      ? 'failing'
      : commands.some((command) => command.status === 'stale-command')
        ? 'stale-command'
        : commands.some((command) => command.status === 'over-target')
          ? 'over-target'
          : commands.some((command) => command.status === 'calibrating')
            ? 'calibrating'
            : 'within-target',
    commands,
  };
}

export function renderMarkdownCalibrationSummary(summary) {
  const lines = [
    '## Local Calibration Timing Summary',
    '',
    `Calibration files: ${summary.sampleCount}`,
    `Command samples: ${summary.commandSampleCount}`,
    `Minimum samples for hard status: ${summary.minSamples}`,
    `Overall status: ${summary.status}`,
    '',
    '| Command | Owner | Samples | p50 | p95 | Budget | Status | Notes |',
    '|---|---|---:|---:|---:|---:|---|---|',
  ];
  for (const command of summary.commands) {
    const notes = [
      command.recordedBudgetStale ? `recorded budget ${formatDuration(command.recordedBudgetMs)}` : '',
      command.failureCount > 0 ? `${command.failureCount} failures` : '',
      command.recordedCommandStale
        ? `${command.staleCommandSampleCount} stale command definition`
        : '',
      command.ignoredStaleCommandSampleCount > 0
        ? `${command.ignoredStaleCommandSampleCount} stale samples ignored`
        : '',
    ]
      .filter(Boolean)
      .join('; ');
    lines.push(
      `| ${command.name} | ${command.owner} | ${command.sampleCount} | ${formatDuration(command.p50Ms)} | ${formatDuration(command.p95Ms)} | ${formatDuration(command.currentBudgetMs)} | ${command.status} | ${notes} |`
    );
  }
  return lines.join('\n');
}

async function listCalibrationPaths(inputDirs) {
  const paths = [];
  for (const dir of inputDirs) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.isFile() &&
        entry.name.startsWith('pipeline-calibration-') &&
        !entry.name.startsWith('pipeline-calibration-summary-') &&
        entry.name.endsWith('.json')
      ) {
        paths.push(path.join(dir, entry.name));
      }
    }
  }
  return paths.sort();
}

async function readCalibrationPath(inputPath) {
  return {
    document: JSON.parse(await readFile(inputPath, 'utf8')),
    sourcePath: inputPath,
  };
}

export async function runCli(args = process.argv.slice(2)) {
  let options;
  try {
    options = parseCalibrationSummaryArgs(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const inputPaths = [...options.inputPaths, ...(await listCalibrationPaths(options.inputDirs))];
  if (inputPaths.length === 0) {
    console.error('at least one --input or --input-dir is required');
    return 1;
  }
  let documents;
  try {
    documents = await Promise.all(inputPaths.map((inputPath) => readCalibrationPath(inputPath)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  let summary;
  try {
    summary = parseCalibrationSummary(documents, { minSamples: options.minSamples });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const markdown = `${renderMarkdownCalibrationSummary(summary)}\n`;
  const json = `${JSON.stringify(summary, null, 2)}\n`;
  if (options.output) {
    await writeFile(options.output, markdown);
  } else {
    console.log(markdown.trimEnd());
  }
  if (options.jsonOutput) {
    await writeFile(options.jsonOutput, json);
  }
  return ['failing', 'over-target', 'stale-command'].includes(summary.status) ? 1 : 0;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath === modulePath) {
  const exitCode = await runCli();
  process.exit(exitCode);
}
