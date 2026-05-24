#!/usr/bin/env node

import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PROOF_PATH = '.ci/proof/latest.json';
export const CHANGED_UNIT_TEST_MODE = 'changed-unit-tests';
export const AFFECTED_WORKSPACES_MODE = 'affected-workspaces';

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

export function parseUnitProofModeArgs(args = process.argv.slice(2)) {
  return {
    githubOutput: readFlagValue(args, '--github-output') ?? process.env.GITHUB_OUTPUT,
    proof: readFlagValue(args, '--proof') ?? DEFAULT_PROOF_PATH,
  };
}

export function detectUnitProofMode(manifest) {
  const commands = manifest?.selection?.commands;
  if (!Array.isArray(commands)) {
    throw new Error('proof manifest selection.commands must be an array');
  }
  return commands.some((command) => command?.name === CHANGED_UNIT_TEST_MODE)
    ? CHANGED_UNIT_TEST_MODE
    : AFFECTED_WORKSPACES_MODE;
}

export async function readUnitProofMode(proofPath) {
  const manifest = JSON.parse(await readFile(proofPath, 'utf8'));
  return detectUnitProofMode(manifest);
}

export async function writeGithubOutput(outputPath, mode) {
  if (!outputPath) {
    return;
  }
  await appendFile(outputPath, `mode=${mode}\n`);
}

export async function runCli(args = process.argv.slice(2)) {
  let options;
  try {
    options = parseUnitProofModeArgs(args);
    const mode = await readUnitProofMode(options.proof);
    console.log(mode);
    await writeGithubOutput(options.githubOutput, mode);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath === modulePath) {
  const exitCode = await runCli();
  process.exit(exitCode);
}
