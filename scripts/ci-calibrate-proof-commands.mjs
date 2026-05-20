#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LOCAL_PROOF_COMMANDS } from './ci-select.mjs';

const FULL_SUITE_COMMAND = 'full-local-suite';

function nowIso() {
  return new Date().toISOString();
}

function readFlagValues(args, name) {
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
  return values;
}

function readFlagValue(args, name) {
  const values = readFlagValues(args, name);
  if (values.length > 1) {
    throw new Error(`${name} can only be provided once`);
  }
  return values[0];
}

function assertKnownCommand(name) {
  if (!LOCAL_PROOF_COMMANDS[name]) {
    throw new Error(`unknown local proof command ${name}`);
  }
}

export function parseCalibrationArgs(args = process.argv.slice(2)) {
  const normalizedArgs = args.filter((arg) => arg !== '--');
  const commandNames = readFlagValues(normalizedArgs, '--command');
  const output = readFlagValue(normalizedArgs, '--output');
  const allowFull = normalizedArgs.includes('--allow-full');
  const dryRun = normalizedArgs.includes('--dry-run');
  const knownFlags = new Set(['--command', '--output', '--allow-full', '--dry-run']);
  for (let index = 0; index < normalizedArgs.length; index += 1) {
    const arg = normalizedArgs[index];
    if (!arg.startsWith('--')) {
      continue;
    }
    if (!knownFlags.has(arg)) {
      throw new Error(`unknown flag ${arg}`);
    }
    if (['--command', '--output'].includes(arg)) {
      index += 1;
    }
  }
  if (commandNames.length === 0) {
    throw new Error('at least one --command is required');
  }
  for (const commandName of commandNames) {
    assertKnownCommand(commandName);
    if (commandName === FULL_SUITE_COMMAND && !allowFull) {
      throw new Error('full-local-suite calibration requires --allow-full');
    }
  }
  return {
    allowFull,
    commandNames,
    dryRun,
    output,
  };
}

function renderCommand(command) {
  if (command.command.includes('<mergeBase>')) {
    throw new Error(
      `${command.name} requires merge-base substitution and is not supported by explicit calibration`
    );
  }
  return command.command;
}

async function defaultRunner(command) {
  return await new Promise((resolve) => {
    const child = spawn(command, {
      shell: '/bin/sh',
      stdio: 'inherit',
    });
    child.on('error', () => resolve(1));
    child.on('close', (exitCode) => resolve(exitCode ?? 1));
  });
}

export function buildCalibrationPlan(commandNames) {
  return commandNames.map((name) => {
    const command = LOCAL_PROOF_COMMANDS[name];
    return {
      budgetMs: command.budgetMs,
      command: renderCommand(command),
      name: command.name,
      owner: command.owner,
      requiredFor: command.requiredFor,
    };
  });
}

export async function runCalibration(options, runner = defaultRunner) {
  const plan = buildCalibrationPlan(options.commandNames);
  const results = [];
  if (options.dryRun) {
    return {
      schemaVersion: 1,
      generatedAt: nowIso(),
      dryRun: true,
      commandResults: plan.map((command) => ({ ...command, exitCode: null })),
    };
  }
  for (const command of plan) {
    const startedAt = Date.now();
    const exitCode = await runner(command.command, command);
    const durationMs = Date.now() - startedAt;
    results.push({
      ...command,
      budgetStatus: durationMs > command.budgetMs ? 'over-budget' : 'ok',
      durationMs,
      exitCode,
    });
    if (exitCode !== 0) {
      break;
    }
  }
  return {
    schemaVersion: 1,
    generatedAt: nowIso(),
    dryRun: false,
    commandResults: results,
  };
}

async function writeJsonOutput(outputPath, result) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
}

export async function runCli(args = process.argv.slice(2), runner = defaultRunner) {
  let options;
  try {
    options = parseCalibrationArgs(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  let result;
  try {
    result = await runCalibration(options, runner);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  if (options.output) {
    await writeJsonOutput(options.output, result);
  }
  console.log(JSON.stringify(result, null, 2));
  return result.commandResults.some((entry) => entry.exitCode !== 0) ? 1 : 0;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath === modulePath) {
  const exitCode = await runCli();
  process.exit(exitCode);
}
