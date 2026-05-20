#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatDuration } from './ci-timing-summary.mjs';

function formatOptionalDuration(ms) {
  return typeof ms === 'number' ? formatDuration(ms) : '-';
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readFlagValue(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) {
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${name} requires a value`);
    }
    values.push(value);
    index += 1;
  }
  if (values.length > 1) {
    throw new Error(`${name} can only be provided once`);
  }
  return values[0];
}

export function parseRiskAuditArgs(args = process.argv.slice(2)) {
  const normalizedArgs = args.filter((arg) => arg !== '--');
  const knownFlags = new Set([
    '--calibration',
    '--json-output',
    '--output',
    '--selection',
    '--strict',
  ]);
  for (let index = 0; index < normalizedArgs.length; index += 1) {
    const arg = normalizedArgs[index];
    if (!arg.startsWith('--')) {
      continue;
    }
    if (!knownFlags.has(arg)) {
      throw new Error(`unknown flag ${arg}`);
    }
    if (arg !== '--strict') {
      index += 1;
    }
  }
  const selection = readFlagValue(normalizedArgs, '--selection');
  const calibration = readFlagValue(normalizedArgs, '--calibration');
  if (!selection) {
    throw new Error('--selection is required');
  }
  if (!calibration) {
    throw new Error('--calibration is required');
  }
  return {
    calibration,
    jsonOutput: readFlagValue(normalizedArgs, '--json-output'),
    output: readFlagValue(normalizedArgs, '--output'),
    selection,
    strict: normalizedArgs.includes('--strict'),
  };
}

function asCommandArray(selection) {
  if (!isObject(selection)) {
    throw new Error('selection must be an object');
  }
  if (!Array.isArray(selection.commands)) {
    throw new Error('selection.commands must be an array');
  }
  return selection.commands;
}

function readSelectedCommand(command) {
  if (!isObject(command)) {
    throw new Error('selected command must be an object');
  }
  if (typeof command.name !== 'string' || command.name.length === 0) {
    throw new Error('selected command name must be a string');
  }
  if (typeof command.owner !== 'string' || command.owner.length === 0) {
    throw new Error(`selected command ${command.name} owner must be a string`);
  }
  if (typeof command.budgetMs !== 'number') {
    throw new Error(`selected command ${command.name} budgetMs must be a number`);
  }
  if (typeof command.command !== 'string') {
    throw new Error(`selected command ${command.name} command must be a string`);
  }
  return command;
}

function readCalibrationCommands(calibrationSummary) {
  if (!isObject(calibrationSummary)) {
    throw new Error('calibration summary must be an object');
  }
  if (!Array.isArray(calibrationSummary.commands)) {
    throw new Error('calibration summary commands must be an array');
  }
  const commands = new Map();
  for (const command of calibrationSummary.commands) {
    if (!isObject(command)) {
      throw new Error('calibration command must be an object');
    }
    if (typeof command.name !== 'string' || command.name.length === 0) {
      throw new Error('calibration command name must be a string');
    }
    commands.set(command.name, command);
  }
  return commands;
}

function readRiskProfile(selection) {
  const riskProfile = selection?.riskProfile;
  if (!isObject(riskProfile)) {
    return {
      category: 'unknown',
      domains: [],
      riskLevel: 'unknown',
    };
  }
  return {
    category:
      typeof riskProfile.category === 'string' ? riskProfile.category : 'unknown',
    domains: Array.isArray(riskProfile.domains) ? riskProfile.domains : [],
    riskLevel:
      typeof riskProfile.riskLevel === 'string' ? riskProfile.riskLevel : 'unknown',
  };
}

function readBudget(selection) {
  const budget = selection?.budget;
  if (!isObject(budget)) {
    return null;
  }
  return {
    status: typeof budget.status === 'string' ? budget.status : 'unknown',
    target: typeof budget.target === 'string' ? budget.target : 'unknown',
    targetMs: typeof budget.targetMs === 'number' ? budget.targetMs : null,
    totalMs: typeof budget.totalMs === 'number' ? budget.totalMs : null,
  };
}

function commandStatus(evidence) {
  if (!evidence) {
    return 'missing';
  }
  return typeof evidence.status === 'string' ? evidence.status : 'unknown';
}

function commandEvidence(status) {
  if (status === 'missing') {
    return 'missing-calibration';
  }
  if (['failing', 'over-target', 'calibrating', 'stale-command'].includes(status)) {
    return status;
  }
  return 'measured';
}

function summarizeAuditStatus(commands) {
  const statuses = commands.map((command) => command.calibrationStatus);
  if (statuses.includes('failing')) {
    return 'failing';
  }
  if (statuses.includes('over-target')) {
    return 'over-target';
  }
  if (statuses.includes('stale-command')) {
    return 'stale-command';
  }
  if (statuses.includes('missing')) {
    return 'missing-calibration';
  }
  if (statuses.includes('calibrating')) {
    return 'calibrating';
  }
  return 'within-target';
}

export function buildRiskAudit(selection, calibrationSummary) {
  const calibrationCommands = readCalibrationCommands(calibrationSummary);
  const commands = asCommandArray(selection).map((command) => {
    const selected = readSelectedCommand(command);
    const calibration = calibrationCommands.get(selected.name);
    const calibrationStatus = commandStatus(calibration);
    return {
      name: selected.name,
      owner: selected.owner,
      command: selected.command,
      selectedBudgetMs: selected.budgetMs,
      currentBudgetMs:
        isObject(calibration) && typeof calibration.currentBudgetMs === 'number'
          ? calibration.currentBudgetMs
          : selected.budgetMs,
      p50Ms:
        isObject(calibration) && typeof calibration.p50Ms === 'number'
          ? calibration.p50Ms
          : null,
      p95Ms:
        isObject(calibration) && typeof calibration.p95Ms === 'number'
          ? calibration.p95Ms
          : null,
      sampleCount:
        isObject(calibration) && typeof calibration.sampleCount === 'number'
          ? calibration.sampleCount
          : 0,
      calibrationStatus,
      evidence: commandEvidence(calibrationStatus),
      failureCount:
        isObject(calibration) && typeof calibration.failureCount === 'number'
          ? calibration.failureCount
          : 0,
    };
  });
  return {
    schemaVersion: 1,
    generatedFrom: 'selection-and-calibration-summary',
    status: summarizeAuditStatus(commands),
    riskProfile: readRiskProfile(selection),
    budget: readBudget(selection),
    commands,
  };
}

export function renderMarkdownRiskAudit(audit) {
  const budget = audit.budget;
  const lines = [
    '## Risk Audit',
    '',
    `Risk category: ${audit.riskProfile.category}`,
    `Domains: ${audit.riskProfile.domains.join(', ') || 'none'}`,
    `Risk level: ${audit.riskProfile.riskLevel}`,
    `Overall status: ${audit.status}`,
  ];
  if (budget) {
    lines.push(
      `Selected budget: ${budget.target} / ${formatDuration(budget.totalMs)} of ${formatDuration(
        budget.targetMs
      )} (${budget.status})`
    );
  }
  lines.push(
    '',
    '| Command | Owner | Samples | p50 | p95 | Budget | Evidence | Status |',
    '|---|---|---:|---:|---:|---:|---|---|'
  );
  for (const command of audit.commands) {
    lines.push(
      `| ${command.name} | ${command.owner} | ${command.sampleCount} | ${formatOptionalDuration(
        command.p50Ms
      )} | ${formatOptionalDuration(command.p95Ms)} | ${formatOptionalDuration(
        command.currentBudgetMs
      )} | ${command.evidence} | ${command.calibrationStatus} |`
    );
  }
  return lines.join('\n');
}

async function readJson(inputPath) {
  return JSON.parse(await readFile(inputPath, 'utf8'));
}

export async function runCli(args = process.argv.slice(2)) {
  let options;
  try {
    options = parseRiskAuditArgs(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  let audit;
  try {
    audit = buildRiskAudit(
      await readJson(options.selection),
      await readJson(options.calibration)
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const markdown = `${renderMarkdownRiskAudit(audit)}\n`;
  const json = `${JSON.stringify(audit, null, 2)}\n`;
  if (options.output) {
    await writeFile(options.output, markdown);
  } else {
    console.log(markdown.trimEnd());
  }
  if (options.jsonOutput) {
    await writeFile(options.jsonOutput, json);
  }
  if (
    audit.status === 'failing' ||
    audit.status === 'over-target' ||
    audit.status === 'stale-command'
  ) {
    return 1;
  }
  return options.strict && audit.status !== 'within-target' ? 1 : 0;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath === modulePath) {
  const exitCode = await runCli();
  process.exit(exitCode);
}
