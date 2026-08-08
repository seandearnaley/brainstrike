import path from 'node:path';
import {
  MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET,
  ToolProjectionInputRejectedError,
} from '@brainstrike/agent';

export interface ExecuteCommandTextModelOutput {
  type: 'text';
  value: string;
}

interface ExecuteCommandProjectionResult {
  ambiguousRootNames?: string[];
  command: string;
  cwd: string;
  durationMs: number;
  exitCode: number | null;
  hint?: string;
  openRoots?: number;
  rootId?: string;
  rootName: string;
  signal: string | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
  truncated: boolean;
}

// Tiny local copies pending post-BST-1195 unification with workspace-model-projection-helpers.ts.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function escapeProjectionLabelLineBreaks(value: string): string {
  return value
    .replace(/\r/gu, String.raw`\r`)
    .replace(/\n/gu, String.raw`\n`)
    .replace(/\u2028/gu, String.raw`\u2028`)
    .replace(/\u2029/gu, String.raw`\u2029`);
}

function parseExecuteCommandResult(output: unknown): ExecuteCommandProjectionResult {
  if (
    !(
      isRecord(output) &&
      (output['ambiguousRootNames'] === undefined ||
        (Array.isArray(output['ambiguousRootNames']) &&
          output['ambiguousRootNames'].every((name) => typeof name === 'string'))) &&
      typeof output['command'] === 'string' &&
      typeof output['cwd'] === 'string' &&
      isNonNegativeInteger(output['durationMs']) &&
      (output['exitCode'] === null ||
        (typeof output['exitCode'] === 'number' && Number.isInteger(output['exitCode']))) &&
      (output['hint'] === undefined || typeof output['hint'] === 'string') &&
      (output['openRoots'] === undefined || isPositiveInteger(output['openRoots'])) &&
      (output['rootId'] === undefined || typeof output['rootId'] === 'string') &&
      typeof output['rootName'] === 'string' &&
      (output['signal'] === null || typeof output['signal'] === 'string') &&
      typeof output['stderr'] === 'string' &&
      typeof output['stdout'] === 'string' &&
      typeof output['timedOut'] === 'boolean' &&
      typeof output['truncated'] === 'boolean'
    )
  ) {
    throw new ToolProjectionInputRejectedError(
      'executeCommand model projection received a malformed result'
    );
  }
  return output as unknown as ExecuteCommandProjectionResult;
}

function resolveRootLabel(result: ExecuteCommandProjectionResult): string | null {
  if ((result.openRoots ?? 1) <= 1) {
    return null;
  }
  const name = result.rootName.trim();
  const ambiguous = new Set(
    (result.ambiguousRootNames ?? []).map((rootName) => rootName.toLowerCase())
  );
  if (name && !ambiguous.has(name.toLowerCase())) {
    return escapeProjectionLabelLineBreaks(name);
  }
  if (result.rootId) {
    return escapeProjectionLabelLineBreaks(result.rootId);
  }
  return null;
}

const EXIT_CODE_INTERPRETATIONS: Readonly<Record<string, string>> = {
  'diff:1': 'files differ',
  'grep:1': 'no matches',
  'rg:1': 'no matches',
};

function resolveExecutedBinaryName(command: string): string | null {
  const firstToken = command.trim().split(/\s+/u)[0];
  if (!firstToken) {
    return null;
  }
  // Deliberately naive: shell prefixes/assignments do not resolve through to a later executable.
  const basename =
    firstToken.includes('/') || firstToken.includes('\\')
      ? path.win32.basename(path.posix.basename(firstToken))
      : firstToken;
  return basename.replace(/\.(?:bat|cmd|exe)$/iu, '').toLowerCase();
}

function resolveExitCodeInterpretation(result: ExecuteCommandProjectionResult): string | null {
  if (result.exitCode === null) {
    return null;
  }
  const binaryName = resolveExecutedBinaryName(result.command);
  if (!binaryName) {
    return null;
  }
  return EXIT_CODE_INTERPRETATIONS[`${binaryName}:${result.exitCode}`] ?? null;
}

function buildExecuteCommandProjection(
  result: ExecuteCommandProjectionResult
): ExecuteCommandTextModelOutput {
  const interpretation = resolveExitCodeInterpretation(result);
  const rootLabel = resolveRootLabel(result);
  const headerParts = [
    'exec',
    `exit=${result.exitCode ?? 'null'}`,
    `${(result.durationMs / 1000).toFixed(1)}s`,
    ...(interpretation ? [`(${interpretation})`] : []),
    ...(result.timedOut ? ['timed_out'] : []),
    ...(result.signal === null ? [] : [`killed=${result.signal}`]),
    ...(result.truncated ? ['truncated'] : []),
    ...(rootLabel ? [`root=${rootLabel}`] : []),
  ];
  const lines = [headerParts.join(' ')];
  if (result.stdout.length > 0) {
    lines.push(result.stdout);
  }
  if (result.stderr.length > 0) {
    lines.push('[stderr]', result.stderr);
  }
  if (result.stdout.length === 0 && result.stderr.length === 0) {
    lines.push('(no output)');
  }
  if (result.hint && result.hint.length > 0) {
    lines.push(result.hint);
  }
  return { type: 'text', value: lines.join('\n') };
}

export function projectExecuteCommandModelOutput(output: unknown): ExecuteCommandTextModelOutput {
  if (
    isRecord(output) &&
    Reflect.ownKeys(output).length === 2 &&
    Object.hasOwn(output, 'type') &&
    Object.hasOwn(output, 'value') &&
    output['type'] === 'text' &&
    typeof output['value'] === 'string' &&
    output['value'].startsWith('exec ')
  ) {
    const replayed = { type: 'text' as const, value: output['value'] };
    if (JSON.stringify(replayed).length > MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET) {
      throw new RangeError(
        `executeCommand stored model projection exceeds the ${MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET}-character domain budget`
      );
    }
    return replayed;
  }

  const result = parseExecuteCommandResult(output);
  const projected = buildExecuteCommandProjection(result);
  if (JSON.stringify(projected).length > MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET) {
    throw new RangeError(
      `executeCommand model projection exceeds the ${MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET}-character domain budget`
    );
  }
  return projected;
}
