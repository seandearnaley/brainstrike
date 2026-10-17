import path from 'node:path';
import {
  CEILING_SCALED_TOOL_RESULT_BUDGET,
  MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET,
  ToolProjectionInputRejectedError,
} from '@brainstrike/agent';
import { fitHeadAndTailToCharBudget, TRUNCATION_HINT } from './execute-command-tool.js';
import {
  escapeProjectionPathLineBreaks,
  isNonNegativeInteger,
  isPositiveInteger,
  isRecord,
  makeWorkspaceTextModelOutput,
  type WorkspaceTextModelOutput,
} from './workspace-model-projection-helpers.js';

// Only the STRUCTURAL helpers above (type guards, the line-break escaper, the
// {type,value} constructor) are shared. Budget-FITTING logic stays local to
// this file (see fitProjectionToBudget below) rather than reusing
// clipProjectionEnd/clipProjectionMiddle/serializedWorkspaceTextModelOutputChars
// from workspace-model-projection-helpers.ts, since those measurement helpers
// are mid-rewrite under BST-1195 — PR #2339 review settled this split.
export type ExecuteCommandTextModelOutput = WorkspaceTextModelOutput;

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
    return escapeProjectionPathLineBreaks(name);
  }
  if (result.rootId) {
    return escapeProjectionPathLineBreaks(result.rootId);
  }
  return null;
}

const EXIT_CODE_INTERPRETATIONS: Readonly<Record<string, string>> = {
  'diff:1': 'files differ',
  'grep:1': 'no matches',
  'rg:1': 'no matches',
};

/**
 * A compound or pipelined command's FINAL exit code does not necessarily
 * belong to the leading token: `grep needle f; false` exits 1 from `false`,
 * not a failed grep, and `diff a b | tee out` exits from `tee`, not `diff`.
 * Any shell operator that can REBIND which command's status the shell
 * reports disqualifies the annotation outright — pipe and logical-AND/OR
 * share `|`/`&` characters (one check covers all three), plus sequencing
 * `;` and an explicit `return`. This is deliberately whole-command, not
 * leading-token-relative: the hazard is exit-code rebinding ANYWHERE in the
 * command, not just before the first token (PR #2339 review).
 */
const EXIT_CODE_REBINDING_PATTERN = /[|;&]|\breturn\b/u;

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
  if (EXIT_CODE_REBINDING_PATTERN.test(result.command)) {
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
  return makeWorkspaceTextModelOutput(lines);
}

/**
 * Self-fit stdout/stderr down to the tighter domain budget when the
 * producer's own NATIVE_TOOL_RESULT_CHAR_BUDGET-fitted result (up to 11,000
 * chars) still doesn't fit MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET (6,000
 * chars) — a legal, ordinary producer result (a `cat` of a 9 KB file, a test
 * run, `git log`) rendered verbatim can land in that gap. Every other
 * purpose-built projector in this codebase self-fits rather than throwing
 * for a case this common (PR #2339 review); RangeError is reserved for the
 * genuinely unreachable case where even a zero-content envelope doesn't fit.
 *
 * Reuses fitHeadAndTailToCharBudget — the SAME head+tail-with-marker shape
 * the producer already applies — via the identical stdout-priority 60/40
 * content-budget bisection buildResult uses, so this can only ever TIGHTEN
 * retention, never re-expand or double-truncate differently.
 */
function fitProjectionToBudget(
  result: ExecuteCommandProjectionResult,
  budget: number
): ExecuteCommandTextModelOutput {
  const hasStdout = result.stdout.length > 0;
  const hasStderr = result.stderr.length > 0;

  const build = (contentBudget: number): ExecuteCommandTextModelOutput => {
    let stdoutBudget: number;
    let stderrBudget: number;
    if (hasStdout && hasStderr) {
      stdoutBudget = Math.floor(contentBudget * 0.6);
      stderrBudget = contentBudget - stdoutBudget;
    } else if (hasStdout) {
      stdoutBudget = contentBudget;
      stderrBudget = 0;
    } else {
      stdoutBudget = 0;
      stderrBudget = contentBudget;
    }
    const fittedStdout = hasStdout
      ? fitHeadAndTailToCharBudget(result.stdout, stdoutBudget)
      : { text: '', truncated: false };
    const fittedStderr = hasStderr
      ? fitHeadAndTailToCharBudget(result.stderr, stderrBudget)
      : { text: '', truncated: false };
    const truncated = result.truncated || fittedStdout.truncated || fittedStderr.truncated;
    // exactOptionalPropertyTypes: an optional `hint?: string` must be OMITTED
    // when absent, never explicitly set to `undefined` — so `hint` is only
    // added here when this fit newly truncated content the producer's own
    // hint didn't already cover; an existing hint passes through unmodified
    // via the `...result` spread below.
    const needsFreshHint = truncated && result.hint === undefined;
    return buildExecuteCommandProjection({
      ...result,
      ...(needsFreshHint ? { hint: TRUNCATION_HINT } : {}),
      stderr: fittedStderr.text,
      stdout: fittedStdout.text,
      truncated,
    });
  };

  const nominalContentBudget = result.stdout.length + result.stderr.length;
  let low = 0;
  let high = nominalContentBudget;
  let best = build(0);
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = build(mid);
    if (JSON.stringify(candidate).length <= budget) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

export function projectExecuteCommandModelOutput(
  output: unknown,
  domainModelResultCharBudget = MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET
): ExecuteCommandTextModelOutput {
  if (
    isRecord(output) &&
    Reflect.ownKeys(output).length === 2 &&
    Object.hasOwn(output, 'type') &&
    Object.hasOwn(output, 'value') &&
    output['type'] === 'text' &&
    typeof output['value'] === 'string' &&
    output['value'].startsWith('exec ')
  ) {
    const replayed = makeWorkspaceTextModelOutput([output['value']]);
    if (
      JSON.stringify(replayed).length >
      CEILING_SCALED_TOOL_RESULT_BUDGET.domainModelResultCharBudget
    ) {
      throw new RangeError(
        `executeCommand stored model projection exceeds the ${CEILING_SCALED_TOOL_RESULT_BUDGET.domainModelResultCharBudget}-character domain budget`
      );
    }
    return replayed;
  }

  const result = parseExecuteCommandResult(output);
  const projected = buildExecuteCommandProjection(result);
  if (JSON.stringify(projected).length <= domainModelResultCharBudget) {
    return projected;
  }

  const fitted = fitProjectionToBudget(result, domainModelResultCharBudget);
  if (JSON.stringify(fitted).length > domainModelResultCharBudget) {
    throw new RangeError(
      `executeCommand model projection exceeds the ${domainModelResultCharBudget}-character domain budget even after self-fitting`
    );
  }
  return fitted;
}
