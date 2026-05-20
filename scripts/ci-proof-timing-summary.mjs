#!/usr/bin/env node

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function asPositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nearestRank(values, percentile) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil((percentile / 100) * sorted.length);
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank - 1))];
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

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readCategory(manifest) {
  const category = manifest?.selection?.riskProfile?.category;
  if (typeof category !== 'string' || category.length === 0) {
    throw new Error('proof manifest is missing selection.riskProfile.category');
  }
  return category;
}

function readBudget(manifest) {
  const budget = manifest?.selection?.budget;
  if (!isObject(budget)) {
    throw new Error('proof manifest is missing selection.budget');
  }
  if (typeof budget.target !== 'string') {
    throw new Error('proof manifest selection.budget.target must be a string');
  }
  if (typeof budget.targetMs !== 'number') {
    throw new Error('proof manifest selection.budget.targetMs must be a number');
  }
  return budget;
}

function readCommandResults(manifest) {
  const commandResults = manifest?.commandResults;
  if (!Array.isArray(commandResults)) {
    throw new Error('proof manifest commandResults must be an array');
  }
  return commandResults.map((result) => {
    if (!isObject(result)) {
      throw new Error('proof manifest command result must be an object');
    }
    if (typeof result.name !== 'string') {
      throw new Error('proof manifest command result name must be a string');
    }
    if (typeof result.owner !== 'string') {
      throw new Error(`proof manifest command ${result.name} owner must be a string`);
    }
    if (typeof result.durationMs !== 'number') {
      throw new Error(`proof manifest command ${result.name} durationMs must be a number`);
    }
    if (typeof result.budgetMs !== 'number') {
      throw new Error(`proof manifest command ${result.name} budgetMs must be a number`);
    }
    return {
      budgetMs: result.budgetMs,
      command: result.name,
      durationMs: result.durationMs,
      owner: result.owner,
    };
  });
}

function summarizeCategory(category, samples, minSamples) {
  const totals = samples.map((sample) => sample.totalDurationMs);
  const p50Ms = nearestRank(totals, 50);
  const p95Ms = nearestRank(totals, 95);
  const targetMs = samples[0].targetMs;
  const commandGroups = new Map();
  for (const sample of samples) {
    for (const command of sample.commands) {
      const key = command.command;
      const existing =
        commandGroups.get(key) ??
        {
          budgetMs: command.budgetMs,
          command: command.command,
          durations: [],
          owner: command.owner,
        };
      existing.durations.push(command.durationMs);
      commandGroups.set(key, existing);
    }
  }
  const status =
    samples.length < minSamples ? 'calibrating' : p95Ms > targetMs ? 'over-target' : 'within-target';
  return {
    category,
    target: samples[0].target,
    targetMs,
    sampleCount: samples.length,
    p50Ms,
    p95Ms,
    status,
    commands: [...commandGroups.values()]
      .map((command) => {
        const commandP95 = nearestRank(command.durations, 95);
        return {
          budgetMs: command.budgetMs,
          owner: command.owner,
          p50Ms: nearestRank(command.durations, 50),
          p95Ms: commandP95,
          sampleCount: command.durations.length,
          status: command.durations.length < minSamples
            ? 'calibrating'
            : commandP95 > command.budgetMs
              ? 'over-target'
              : 'within-target',
          command: command.command,
        };
      })
      .sort((left, right) => left.command.localeCompare(right.command)),
  };
}

export function parseProofTimingSummary(manifests, options = {}) {
  const minSamples = asPositiveInteger(options.minSamples, 5);
  const groups = new Map();
  for (const manifest of manifests) {
    const category = readCategory(manifest);
    const budget = readBudget(manifest);
    const commands = readCommandResults(manifest);
    const sample = {
      target: budget.target,
      targetMs: budget.targetMs,
      totalDurationMs: commands.reduce((sum, command) => sum + command.durationMs, 0),
      commands,
    };
    groups.set(category, [...(groups.get(category) ?? []), sample]);
  }
  const categories = [...groups.entries()]
    .map(([category, samples]) => summarizeCategory(category, samples, minSamples))
    .sort((left, right) => left.category.localeCompare(right.category));
  return {
    schemaVersion: 1,
    generatedFrom: 'proof-manifests',
    minSamples,
    sampleCount: manifests.length,
    categories,
  };
}

export function renderMarkdownProofTimingSummary(summary) {
  const lines = [
    '## Local Proof Timing Summary',
    '',
    `Samples: ${summary.sampleCount}`,
    `Minimum samples for hard status: ${summary.minSamples}`,
    '',
    '| Risk Category | Samples | p50 | p95 | Target | Status |',
    '|---|---:|---:|---:|---:|---|',
  ];
  for (const category of summary.categories) {
    lines.push(
      `| ${category.category} | ${category.sampleCount} | ${formatDuration(category.p50Ms)} | ${formatDuration(category.p95Ms)} | ${formatDuration(category.targetMs)} | ${category.status} |`
    );
  }
  lines.push('', '### Commands', '', '| Risk Category | Command | Owner | Samples | p50 | p95 | Budget | Status |', '|---|---|---|---:|---:|---:|---:|---|');
  for (const category of summary.categories) {
    for (const command of category.commands) {
      lines.push(
        `| ${category.category} | ${command.command} | ${command.owner} | ${command.sampleCount} | ${formatDuration(command.p50Ms)} | ${formatDuration(command.p95Ms)} | ${formatDuration(command.budgetMs)} | ${command.status} |`
      );
    }
  }
  return lines.join('\n');
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

async function listManifestPaths(inputDirs) {
  const paths = [];
  for (const dir of inputDirs) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.json')) {
        paths.push(path.join(dir, entry.name));
      }
    }
  }
  return paths.sort();
}

export async function runCli(args = process.argv.slice(2)) {
  let inputPaths;
  let inputDirs;
  let minSamples;
  let output;
  let jsonOutput;
  try {
    inputPaths = readFlagValues(args, '--input');
    inputDirs = readFlagValues(args, '--input-dir');
    minSamples = asPositiveInteger(readFlagValue(args, '--min-samples'), 5);
    output = readFlagValue(args, '--output');
    jsonOutput = readFlagValue(args, '--json-output');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const manifestPaths = [...inputPaths, ...(await listManifestPaths(inputDirs))];
  if (manifestPaths.length === 0) {
    console.error('at least one --input or --input-dir is required');
    return 1;
  }
  const manifests = [];
  for (const manifestPath of manifestPaths) {
    try {
      manifests.push(JSON.parse(await readFile(manifestPath, 'utf8')));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`failed to read proof manifest ${manifestPath}: ${message}`);
      return 1;
    }
  }
  let summary;
  try {
    summary = parseProofTimingSummary(manifests, { minSamples });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const markdown = `${renderMarkdownProofTimingSummary(summary)}\n`;
  const json = `${JSON.stringify(summary, null, 2)}\n`;
  if (output) {
    await writeFile(output, markdown);
  } else {
    console.log(markdown.trimEnd());
  }
  if (jsonOutput) {
    await writeFile(jsonOutput, json);
  }
  return summary.categories.some((category) => category.status === 'over-target') ? 1 : 0;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath === modulePath) {
  const exitCode = await runCli();
  process.exit(exitCode);
}
