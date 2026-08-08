import {
  MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET,
  ToolProjectionInputRejectedError,
} from '@brainstrike/agent';
import {
  isNonNegativeInteger,
  isPositiveInteger,
  isRecord,
} from './workspace-model-projection-helpers';

export interface ReadWorkspaceFileTextModelOutput {
  type: 'text';
  value: string;
}

interface ReadWorkspaceFileProjectionResult {
  content: string;
  endLine: number;
  nextCursor: string | null;
  omittedChars: number;
  openRoots: number;
  path: string;
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
      isPositiveInteger(output['openRoots']) &&
      typeof output['path'] === 'string' &&
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

export function projectReadWorkspaceFileModelOutput(
  output: unknown
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
    const replayed = { type: 'text' as const, value: output['value'] };
    if (JSON.stringify(replayed).length > MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET) {
      throw new RangeError(
        `readWorkspaceFile stored model projection exceeds the ${MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET}-character domain budget`
      );
    }
    return replayed;
  }

  const result = parseReadWorkspaceFileResult(output);
  const displayPath = result.openRoots > 1 ? `${result.rootName}:${result.path}` : result.path;
  const header = `read ${displayPath} lines ${result.startLine}-${result.endLine}/${result.totalLines}${
    result.truncated ? ` | size=${result.size} omitted=${result.omittedChars}` : ''
  }`;
  const footer = result.nextCursor ? `continue: cursor=${result.nextCursor}` : null;
  const lines = [header, result.content, ...(footer ? [footer] : [])];
  const projected = { type: 'text' as const, value: lines.join('\n') };
  if (JSON.stringify(projected).length > MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET) {
    throw new RangeError(
      `readWorkspaceFile model projection exceeds the ${MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET}-character domain budget`
    );
  }
  return projected;
}
