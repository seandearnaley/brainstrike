/**
 * Per-worktree setup (spec §6.3): copy the ignored files `.worktreeinclude`
 * names (the Claude Code / Codex standard) and run one setup command with the
 * `BRAINSTRIKE_*` environment (the Conductor idiom).
 *
 * Failure is visible and non-blocking: the worktree exists and is usable
 * either way, and the bounded outcome is persisted on its ledger row.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fsPromises } from 'node:fs';
import { glob } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@brainstrike/logging';
import type { WorktreeSetupOutcome } from '@brainstrike/types';
import type { WorktreeSetupInput } from './worktree-service';

const logger = createLogger('WorktreeSetup');

export const WORKTREE_SETUP_OUTPUT_CAP_BYTES = 16_384;
export const WORKTREE_SETUP_TIMEOUT_MS = 300_000;
const WORKTREE_INCLUDE_FILE = '.worktreeinclude';
const REPOSITORY_SETUP_SCRIPT = path.join('.brainstrike', 'worktree-setup.sh');
const PORT_BASE = 3000;
const PORT_SPAN = 2000;
const brainstrikePortEnvironmentVariable = 'BRAINSTRIKE_PORT';
const brainstrikeRootPathEnvironmentVariable = 'BRAINSTRIKE_ROOT_PATH';
const brainstrikeWorkspaceNameEnvironmentVariable = 'BRAINSTRIKE_WORKSPACE_NAME';
const brainstrikeWorkspacePathEnvironmentVariable = 'BRAINSTRIKE_WORKSPACE_PATH';

const NONE: WorktreeSetupOutcome = {
  copiedPaths: [],
  output: '',
  reason: null,
  status: 'none',
  truncated: false,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

/**
 * One relative glob per line; `#` comments and blanks are dropped. Absolute
 * and escaping patterns are rejected before any filesystem operation.
 */
export function parseWorktreeInclude(contents: string): readonly string[] {
  const patterns: string[] = [];
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    const segments = line.split(/[\\/]/u);
    if (path.posix.isAbsolute(line) || path.win32.isAbsolute(line) || segments.includes('..')) {
      throw new Error(
        `.worktreeinclude patterns must be relative to the repository root: "${line}"`
      );
    }
    patterns.push(line);
  }
  return patterns;
}

/**
 * The Conductor idiom. The port is derived from the worktree path, making it
 * stable across setup runs and distinct per worktree.
 */
export function worktreeSetupEnvironment(input: {
  readonly rootPath: string;
  readonly worktreeName: string;
  readonly worktreePath: string;
}): Record<string, string> {
  const digest = createHash('sha256').update(input.worktreePath).digest();
  const port = PORT_BASE + (digest.readUInt32BE(0) % PORT_SPAN);
  return {
    [brainstrikePortEnvironmentVariable]: String(port),
    [brainstrikeRootPathEnvironmentVariable]: input.rootPath,
    [brainstrikeWorkspaceNameEnvironmentVariable]: input.worktreeName,
    [brainstrikeWorkspacePathEnvironmentVariable]: input.worktreePath,
  };
}

async function copyIncludedFiles(
  sourcePath: string,
  worktreePath: string
): Promise<readonly string[]> {
  let contents: string;
  try {
    contents = await fsPromises.readFile(path.join(sourcePath, WORKTREE_INCLUDE_FILE), 'utf8');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return [];
    }
    throw error;
  }

  const copied: string[] = [];
  for (const pattern of parseWorktreeInclude(contents)) {
    for await (const match of glob(pattern, { cwd: sourcePath })) {
      const relative = String(match);
      const from = path.join(sourcePath, relative);
      const to = path.join(worktreePath, relative);
      await fsPromises.mkdir(path.dirname(to), { recursive: true });
      await fsPromises.cp(from, to, { recursive: true });
      copied.push(relative);
    }
  }
  return copied.sort();
}

interface ResolvedCommand {
  readonly argv: readonly string[];
  readonly reason: string | null;
}

async function resolveSetupCommand(input: WorktreeSetupInput): Promise<ResolvedCommand | null> {
  if (input.settings.setupCommand !== null) {
    if (input.settings.setupCommand.length === 0) {
      return { argv: [], reason: 'The configured setup command is empty.' };
    }
    return { argv: input.settings.setupCommand, reason: null };
  }

  const script = path.join(input.sourcePath, REPOSITORY_SETUP_SCRIPT);
  try {
    await fsPromises.access(script);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return null;
    }
    throw error;
  }
  if (process.platform === 'win32') {
    return {
      argv: [],
      reason:
        'This repository ships .brainstrike/worktree-setup.sh, which needs a POSIX shell. Set an explicit setup command in Settings → Workspace to run setup on Windows.',
    };
  }
  return { argv: ['/bin/sh', script], reason: null };
}

function capture(stdout: string, stderr: string): { output: string; truncated: boolean } {
  const combined = `${stdout}${stderr}`;
  const buffer = Buffer.from(combined, 'utf8');
  if (buffer.byteLength <= WORKTREE_SETUP_OUTPUT_CAP_BYTES) {
    return { output: combined, truncated: false };
  }

  let output = buffer.subarray(0, WORKTREE_SETUP_OUTPUT_CAP_BYTES).toString('utf8');
  while (Buffer.byteLength(output, 'utf8') > WORKTREE_SETUP_OUTPUT_CAP_BYTES) {
    output = output.slice(0, -1);
  }
  return { output, truncated: true };
}

async function executeSetupCommand(
  command: ResolvedCommand,
  input: WorktreeSetupInput,
  copiedPaths: readonly string[]
): Promise<WorktreeSetupOutcome> {
  const [file, ...args] = command.argv;
  if (file === undefined) {
    return {
      copiedPaths,
      output: '',
      reason: command.reason,
      status: 'skipped',
      truncated: false,
    };
  }

  const env = {
    ...process.env,
    ...worktreeSetupEnvironment({
      rootPath: input.sourcePath,
      worktreeName: path.basename(input.worktree.path),
      worktreePath: input.worktree.path,
    }),
  };

  return await new Promise<WorktreeSetupOutcome>((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: input.worktree.path,
        env,
        maxBuffer: WORKTREE_SETUP_OUTPUT_CAP_BYTES * 8,
        timeout: WORKTREE_SETUP_TIMEOUT_MS,
      },
      (error, stdout, stderr) => {
        const { output, truncated } = capture(String(stdout), String(stderr));
        if (!error) {
          resolve({ copiedPaths, output, reason: null, status: 'succeeded', truncated });
          return;
        }

        const code = typeof error.code === 'number' ? error.code : null;
        const reason =
          error.killed === true
            ? `Setup command timed out after ${WORKTREE_SETUP_TIMEOUT_MS / 1000}s.`
            : code === null
              ? `Setup command failed: ${error.message}`
              : `Setup command exited with code ${code}.`;
        resolve({ copiedPaths, output, reason, status: 'failed', truncated });
      }
    );
  });
}

export async function runWorktreeSetup(input: WorktreeSetupInput): Promise<WorktreeSetupOutcome> {
  let copiedPaths: readonly string[] = [];
  try {
    copiedPaths = await copyIncludedFiles(input.sourcePath, input.worktree.path);
    const command = await resolveSetupCommand(input);
    if (command === null) {
      if (copiedPaths.length === 0) {
        return NONE;
      }
      return {
        copiedPaths,
        output: '',
        reason: null,
        status: 'succeeded',
        truncated: false,
      };
    }
    return await executeSetupCommand(command, input, copiedPaths);
  } catch (error) {
    logger.warn('worktree setup failed', { error, worktree: input.worktree.path });
    return {
      copiedPaths,
      output: '',
      reason: errorMessage(error),
      status: 'failed',
      truncated: false,
    };
  }
}
