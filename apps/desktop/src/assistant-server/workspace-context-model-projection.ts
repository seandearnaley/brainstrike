import {
  MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET,
  type RuntimeWorkspaceRoot,
  ToolProjectionInputRejectedError,
} from '@brainstrike/agent';
import {
  clipProjectionEnd as clipEnd,
  clipProjectionMiddle,
  decodedWorkspaceTextModelOutputChars as decodedChars,
  escapeProjectionPathLineBreaks as escapePathLineBreaks,
  isRecord,
  makeWorkspaceTextModelOutput as makeOutput,
  type WorkspaceTextModelOutput,
} from '@brainstrike/host-capabilities/native-tools';

export type WorkspaceContextTextModelOutput = WorkspaceTextModelOutput;

interface WorkspaceIndexSummary {
  embeddingSetId: string | null;
  enabled: boolean;
  mode: string | null;
  paused: boolean;
}

interface ListWorkspaceContextResult {
  workspaceIndex: WorkspaceIndexSummary;
  workspaceRootPath: string | null;
  workspaceRoots: RuntimeWorkspaceRoot[];
}

const MAX_ID_CHARS = 160;
const MAX_NAME_CHARS = 160;
const MAX_PATH_CHARS = 800;

function isWorkspaceRoot(value: unknown): value is RuntimeWorkspaceRoot {
  return (
    isRecord(value) &&
    typeof value['displayName'] === 'string' &&
    typeof value['path'] === 'string' &&
    typeof value['rootId'] === 'string'
  );
}

function isWorkspaceIndex(value: unknown): value is WorkspaceIndexSummary {
  return (
    isRecord(value) &&
    (value['embeddingSetId'] === null || typeof value['embeddingSetId'] === 'string') &&
    typeof value['enabled'] === 'boolean' &&
    (value['mode'] === null || typeof value['mode'] === 'string') &&
    typeof value['paused'] === 'boolean'
  );
}

function throwMalformed(): never {
  throw new ToolProjectionInputRejectedError(
    'listWorkspaceContext model projection received a malformed result'
  );
}

function parseListWorkspaceContextResult(output: unknown): ListWorkspaceContextResult {
  if (
    !(
      isRecord(output) &&
      isWorkspaceIndex(output['workspaceIndex']) &&
      (output['workspaceRootPath'] === null || typeof output['workspaceRootPath'] === 'string') &&
      Array.isArray(output['workspaceRoots']) &&
      output['workspaceRoots'].every(isWorkspaceRoot)
    )
  ) {
    return throwMalformed();
  }
  const result = output as unknown as ListWorkspaceContextResult;
  // The main root's path is the first root's; no roots means no main path.
  const mainRoot = result.workspaceRoots[0];
  if (mainRoot ? result.workspaceRootPath !== mainRoot.path : result.workspaceRootPath !== null) {
    return throwMalformed();
  }
  return result;
}

function clipPath(value: string): string {
  return clipProjectionMiddle(escapePathLineBreaks(value), MAX_PATH_CHARS, 'path');
}

function contextHeader(result: ListWorkspaceContextResult): string {
  return result.workspaceRoots.length === 0
    ? 'workspace context | roots=0 | main=none'
    : `workspace context | roots=${result.workspaceRoots.length}` +
        ` | main=${clipPath(result.workspaceRootPath ?? '')}`;
}

function indexLine(result: ListWorkspaceContextResult): string {
  const { workspaceIndex } = result;
  return (
    `index | enabled=${workspaceIndex.enabled} | paused=${workspaceIndex.paused}` +
    ` | mode=${workspaceIndex.mode ? clipEnd(workspaceIndex.mode, MAX_NAME_CHARS, 'mode') : 'unavailable'}` +
    ` | embedding_set=${
      workspaceIndex.embeddingSetId
        ? clipEnd(workspaceIndex.embeddingSetId, MAX_ID_CHARS, 'embedding-set-id')
        : 'unavailable'
    }`
  );
}

function rootLine(root: RuntimeWorkspaceRoot, main: boolean): string {
  return (
    `root${main ? ' main' : ''}` +
    ` | name=${clipEnd(root.displayName, MAX_NAME_CHARS, 'root-name')}` +
    ` | id=${clipEnd(root.rootId, MAX_ID_CHARS, 'root-id')}` +
    ` | path=${clipPath(root.path)}`
  );
}

function buildLines(result: ListWorkspaceContextResult, keptOtherRoots: number): string[] {
  const omittedRoots = Math.max(0, result.workspaceRoots.length - 1) - keptOtherRoots;
  return [
    contextHeader(result),
    indexLine(result),
    ...result.workspaceRoots
      .slice(0, keptOtherRoots + 1)
      .map((root, index) => rootLine(root, index === 0)),
    ...(omittedRoots > 0 ? [`projection_omitted: roots=${omittedRoots}`] : []),
  ];
}

export function projectListWorkspaceContextModelOutput(
  output: unknown,
  domainModelResultCharBudget = MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET
): WorkspaceContextTextModelOutput {
  const result = parseListWorkspaceContextResult(output);
  // The main root always shows; the other roots fill the budget in order.
  const otherRoots = Math.max(0, result.workspaceRoots.length - 1);
  let keptOtherRoots = 0;
  while (
    keptOtherRoots < otherRoots &&
    decodedChars(buildLines(result, keptOtherRoots + 1)) <= domainModelResultCharBudget
  ) {
    keptOtherRoots += 1;
  }
  const lines = buildLines(result, keptOtherRoots);
  if (decodedChars(lines) > domainModelResultCharBudget) {
    throw new RangeError(
      `listWorkspaceContext model projection exceeds the ${domainModelResultCharBudget}-character domain budget`
    );
  }
  return makeOutput(lines);
}
