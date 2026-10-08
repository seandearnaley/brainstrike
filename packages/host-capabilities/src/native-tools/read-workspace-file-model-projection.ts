import {
  CEILING_SCALED_TOOL_RESULT_BUDGET,
  MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET,
  ToolProjectionInputRejectedError,
} from '@brainstrike/agent';
import {
  decodedWorkspaceTextModelOutputChars,
  escapeProjectionPathLineBreaks,
  isNonNegativeInteger,
  isPositiveInteger,
  isRecord,
  makeWorkspaceTextModelOutput,
  type WorkspaceTextModelOutput,
} from './workspace-model-projection-helpers.js';

export type ReadWorkspaceFileTextModelOutput = WorkspaceTextModelOutput;

export interface ReadWorkspaceFileProjectionResult {
  ambiguousRootNames?: string[];
  content: string;
  endLine: number;
  nextCursor: string | null;
  omittedChars: number;
  openRoots?: number;
  path: string;
  rootId?: string;
  rootName: string;
  size: number;
  startLine: number;
  totalLines: number;
  truncated: boolean;
}

function parseReadWorkspaceFileResult(output: unknown): ReadWorkspaceFileProjectionResult {
  if (
    !(
      isRecord(output) &&
      typeof output['content'] === 'string' &&
      isPositiveInteger(output['endLine']) &&
      (output['nextCursor'] === null || typeof output['nextCursor'] === 'string') &&
      isNonNegativeInteger(output['omittedChars']) &&
      (output['openRoots'] === undefined || isPositiveInteger(output['openRoots'])) &&
      (output['ambiguousRootNames'] === undefined ||
        (Array.isArray(output['ambiguousRootNames']) &&
          output['ambiguousRootNames'].every((name) => typeof name === 'string'))) &&
      typeof output['path'] === 'string' &&
      (output['rootId'] === undefined || typeof output['rootId'] === 'string') &&
      typeof output['rootName'] === 'string' &&
      isNonNegativeInteger(output['size']) &&
      isPositiveInteger(output['startLine']) &&
      isPositiveInteger(output['totalLines']) &&
      typeof output['truncated'] === 'boolean'
    )
  ) {
    throw new ToolProjectionInputRejectedError(
      'readWorkspaceFile model projection received a malformed result'
    );
  }
  return output as unknown as ReadWorkspaceFileProjectionResult;
}

function unwrapLegacyJsonProjection(output: unknown): unknown {
  if (
    isRecord(output) &&
    Object.keys(output).length === 2 &&
    output['type'] === 'json' &&
    isRecord(output['value'])
  ) {
    return output['value'];
  }
  return output;
}

export function resolveReadWorkspaceFileRootLabel(
  result: Pick<
    ReadWorkspaceFileProjectionResult,
    'ambiguousRootNames' | 'openRoots' | 'rootId' | 'rootName'
  >
): string | null {
  const openRoots = result.openRoots ?? 1;
  if (openRoots <= 1) {
    return null;
  }
  const name = result.rootName?.trim();
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

export function buildReadWorkspaceFileProjectionText(
  result: ReadWorkspaceFileProjectionResult
): WorkspaceTextModelOutput {
  const rootLabel = resolveReadWorkspaceFileRootLabel(result);
  const escapedPath = escapeProjectionPathLineBreaks(result.path);
  const displayPath = rootLabel ? `${rootLabel}:${escapedPath}` : escapedPath;
  const header = `read ${displayPath} lines ${result.startLine}-${result.endLine}/${result.totalLines}${
    result.truncated ? ` | size=${result.size} omitted=${result.omittedChars}` : ''
  }`;
  const footer = result.nextCursor ? `continue: cursor=${result.nextCursor}` : null;
  return makeWorkspaceTextModelOutput([header, result.content, ...(footer ? [footer] : [])]);
}

export function projectReadWorkspaceFileModelOutput(
  output: unknown,
  domainModelResultCharBudget = MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET
): ReadWorkspaceFileTextModelOutput {
  if (
    isRecord(output) &&
    Reflect.ownKeys(output).length === 2 &&
    Object.hasOwn(output, 'type') &&
    Object.hasOwn(output, 'value') &&
    output['type'] === 'text' &&
    typeof output['value'] === 'string' &&
    output['value'].startsWith('read ')
  ) {
    const replayed = makeWorkspaceTextModelOutput([output['value']]);
    if (
      decodedWorkspaceTextModelOutputChars([replayed.value]) >
      CEILING_SCALED_TOOL_RESULT_BUDGET.domainModelResultCharBudget
    ) {
      throw new RangeError(
        `readWorkspaceFile stored model projection exceeds the ${CEILING_SCALED_TOOL_RESULT_BUDGET.domainModelResultCharBudget}-character domain budget`
      );
    }
    return replayed;
  }

  const result = parseReadWorkspaceFileResult(unwrapLegacyJsonProjection(output));
  const projected = buildReadWorkspaceFileProjectionText(result);
  if (decodedWorkspaceTextModelOutputChars([projected.value]) > domainModelResultCharBudget) {
    throw new RangeError(
      `readWorkspaceFile model projection exceeds the ${domainModelResultCharBudget}-character domain budget`
    );
  }
  return projected;
}
