import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMcpLabReferenceRunnerDependencies } from './reference-runner.js';
import { runMcpLabVerification } from './runner.js';

export interface McpLabRunnerCliArgs {
  readonly output: string;
  readonly profile: 'exhaustive' | 'pr';
  readonly sha: string;
  readonly ticket: string;
  readonly workspaceState: 'clean' | 'dirty';
}

function invalid(message: string): never {
  throw new Error(`Invalid MCP lab runner arguments: ${message}`);
}

const CLI_FLAGS = new Set(['--profile', '--ticket', '--output', '--sha', '--workspace-state']);

function collectValues(argv: unknown): ReadonlyMap<string, string> {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== 'string')) {
    invalid('expected a string argument array');
  }
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith('--') || value === undefined || value.startsWith('--')) {
      invalid('arguments must be flag/value pairs');
    }
    if (values.has(flag)) {
      invalid(`duplicate flag "${flag}"`);
    }
    values.set(flag, value);
  }
  for (const flag of values.keys()) {
    if (!CLI_FLAGS.has(flag)) {
      invalid(`unknown flag "${flag}"`);
    }
  }
  if (values.size !== CLI_FLAGS.size) {
    invalid('profile, ticket, output, sha, and workspace-state are required');
  }
  return values;
}

function relativeJsonPath(value: string): string {
  if (isAbsolute(value) || !value.endsWith('.json')) {
    invalid('output must be a relative JSON path');
  }
  const normalized = normalize(value);
  const parentPrefix = `..${process.platform === 'win32' ? '\\' : '/'}`;
  if (normalized === '..' || normalized.startsWith(parentPrefix)) {
    invalid('output must stay inside the working directory');
  }
  return normalized;
}

export function parseMcpLabRunnerCliArgs(argv: unknown): McpLabRunnerCliArgs {
  const values = collectValues(argv);
  const profile = values.get('--profile');
  const ticket = values.get('--ticket');
  const output = values.get('--output');
  const sha = values.get('--sha');
  const workspaceState = values.get('--workspace-state');
  if (profile !== 'pr' && profile !== 'exhaustive') {
    invalid('profile must be "pr" or "exhaustive"');
  }
  if (!(ticket && /^BST-[1-9]\d*$/u.test(ticket))) {
    invalid('ticket must be a BST identifier');
  }
  if (!(sha && /^[0-9a-f]{40}$/u.test(sha))) {
    invalid('sha must be a full lowercase commit SHA');
  }
  if (workspaceState !== 'clean' && workspaceState !== 'dirty') {
    invalid('workspace-state must be "clean" or "dirty"');
  }
  if (!output) {
    invalid('output is required');
  }
  return Object.freeze({ output: relativeJsonPath(output), profile, sha, ticket, workspaceState });
}

export function mcpLabRunnerEvidenceCommand(args: McpLabRunnerCliArgs): string {
  return `pnpm --filter @brainstrike/mcp-test-lab verify -- --profile ${args.profile} --ticket ${args.ticket} --output ${args.output} --sha ${args.sha} --workspace-state ${args.workspaceState}`;
}

export async function runMcpLabRunnerCli(argv: readonly string[]): Promise<void> {
  const args = parseMcpLabRunnerCliArgs(argv);
  const command = mcpLabRunnerEvidenceCommand(args);
  const bundles = await runMcpLabVerification(
    {
      blockers: [],
      command,
      git: { commitSha: args.sha, workspaceState: args.workspaceState },
      selection: { profile: args.profile },
      ticket: args.ticket,
    },
    createMcpLabReferenceRunnerDependencies(),
    { maxArtifactBytes: 1, readArtifactContent: () => new Uint8Array() }
  );
  const outputPath = normalize(args.output);
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  await mkdir(dirname(outputPath), { recursive: true });
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify(
        bundles.map(({ schema }) => schema),
        null,
        2
      )}\n`,
      { encoding: 'utf8', flag: 'wx' }
    );
    await rename(temporaryPath, outputPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  await runMcpLabRunnerCli(process.argv.slice(2));
}
