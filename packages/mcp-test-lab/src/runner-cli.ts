import { execFileSync } from 'node:child_process';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMcpLabReferenceRunnerDependencies } from './reference-runner.js';
import { runMcpLabVerification } from './runner.js';

export interface McpLabRunnerCliArgs {
  readonly output: string;
  readonly profile: 'exhaustive' | 'pr';
}

function invalid(message: string): never {
  throw new Error(`Invalid MCP lab runner arguments: ${message}`);
}

const CLI_FLAGS = new Set(['--profile', '--output']);
const PORTABLE_OUTPUT_PATH = /^[A-Za-z0-9._/-]+\.json$/u;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;

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
    invalid('profile and output are required');
  }
  return values;
}

function relativeJsonPath(value: string): string {
  if (isAbsolute(value) || !PORTABLE_OUTPUT_PATH.test(value)) {
    invalid('output must be a portable relative JSON path using safe path characters');
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
  const output = values.get('--output');
  if (profile !== 'pr' && profile !== 'exhaustive') {
    invalid('profile must be "pr" or "exhaustive"');
  }
  if (!output) {
    invalid('output is required');
  }
  return Object.freeze({ output: relativeJsonPath(output), profile });
}

export function mcpLabRunnerEvidenceCommand(args: McpLabRunnerCliArgs): string {
  return `pnpm run verify:mcp -- --profile ${args.profile} --output ${args.output}`;
}

export function resolveMcpLabRunnerGitEvidence(
  runGit: (args: readonly string[]) => string = (args) =>
    execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
): { readonly commitSha: string; readonly workspaceState: 'clean' | 'dirty' } {
  const commitSha = runGit(['rev-parse', '--verify', 'HEAD']).trim();
  if (!SHA_PATTERN.test(commitSha)) {
    throw new Error('MCP lab runner git identity is not a full lowercase commit SHA');
  }
  const status = runGit(['status', '--porcelain=v1', '--untracked-files=normal']);
  return { commitSha, workspaceState: status.trim() === '' ? 'clean' : 'dirty' };
}

export async function runMcpLabRunnerCli(argv: readonly string[]): Promise<void> {
  const args = parseMcpLabRunnerCliArgs(argv);
  const command = mcpLabRunnerEvidenceCommand(args);
  const git = resolveMcpLabRunnerGitEvidence();
  const bundles = await runMcpLabVerification(
    {
      blockers: [],
      command,
      git,
      selection: { profile: args.profile },
      ticket: 'BST-1486',
    },
    createMcpLabReferenceRunnerDependencies(),
    {
      maxArtifactBytes: 1,
      readArtifactContent: () => {
        throw new Error('MCP reference runner does not emit external artifacts');
      },
    }
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
