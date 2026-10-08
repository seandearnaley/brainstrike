import {
  MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET,
  ToolProjectionInputRejectedError,
} from '@brainstrike/agent';
import {
  clipProjectionEnd as clipEnd,
  clipProjectionMiddle,
  decodedWorkspaceTextModelOutputChars as decodedChars,
  escapeProjectionPathLineBreaks as escapePathLineBreaks,
  isNonNegativeInteger,
  isPositiveInteger,
  isRecord,
  makeWorkspaceTextModelOutput as output,
  projectionSingleLine as singleLine,
  type WorkspaceTextModelOutput,
} from '@brainstrike/host-capabilities/native-tools';

export type WorkspaceRetrievalTextModelOutput = WorkspaceTextModelOutput;

interface SemanticChunk {
  rank: number;
  score?: number;
}

interface SemanticResult {
  budget: number;
  chunkContentIncludedInContext: boolean;
  chunks: SemanticChunk[];
  context: string;
  embeddingSetId: string;
  hint?: string;
  limit: number;
  remainingTokens: number;
  skipped: number;
  skippedForMissingSourceRange: number;
  threshold: number;
  totalTokens: number;
  truncated?: boolean;
}

interface UnavailableResult {
  message: string;
  reason: 'workspace-index-blocked' | 'workspace-index-unavailable';
  status: 'unavailable';
  workspaceIndex: {
    blockedReason: string | null;
    embeddingSetId: string | null;
    enabled: boolean;
    lastError: string | null;
    paused: boolean;
    queueProgress: {
      failed: number;
      pending: number;
      processed: number;
      totalQueued: number;
    } | null;
    statusState: string | null;
  };
}

interface HybridItem {
  chunkIndex: number;
  content: string;
  fileName?: string;
  filePath?: string;
  ftsRank?: number;
  id: string;
  position: number;
  rootName?: string;
  rrfScore: number;
  sourceCount: number;
  vectorSimilarity?: number;
}

interface HybridResult {
  embeddingSetId: string;
  ftsWeight: number;
  hint?: string;
  metadata: {
    ftsResultCount: number;
    fusedResultCount: number;
    totalMs: number;
    vectorResultCount: number;
  };
  results: HybridItem[];
  root?: string;
  truncated: boolean;
  vectorWeight: number;
}

const MAX_EXCERPT_CHARS = 500;
const MAX_ID_CHARS = 160;
const MAX_MESSAGE_CHARS = 1000;
const MAX_PATH_CHARS = 700;
const MAX_ROOT_CHARS = 160;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isSemanticChunk(value: unknown, index: number): value is SemanticChunk {
  return (
    isRecord(value) &&
    value['rank'] === index + 1 &&
    (value['score'] === undefined || isFiniteNumber(value['score']))
  );
}

function hasSemanticNotices(value: Record<string, unknown>): boolean {
  return (
    (value['truncated'] === undefined || typeof value['truncated'] === 'boolean') &&
    isOptionalString(value['hint'])
  );
}

function parseSemanticResult(output: unknown): SemanticResult | UnavailableResult {
  if (
    isRecord(output) &&
    output['status'] === 'unavailable' &&
    (output['reason'] === 'workspace-index-blocked' ||
      output['reason'] === 'workspace-index-unavailable') &&
    typeof output['message'] === 'string' &&
    isRecord(output['workspaceIndex'])
  ) {
    const index = output['workspaceIndex'];
    const queue = index['queueProgress'];
    if (
      (index['blockedReason'] === null || typeof index['blockedReason'] === 'string') &&
      (index['embeddingSetId'] === null || typeof index['embeddingSetId'] === 'string') &&
      typeof index['enabled'] === 'boolean' &&
      (index['lastError'] === null || typeof index['lastError'] === 'string') &&
      typeof index['paused'] === 'boolean' &&
      (index['statusState'] === null || typeof index['statusState'] === 'string') &&
      (queue === null ||
        (isRecord(queue) &&
          isNonNegativeInteger(queue['failed']) &&
          isNonNegativeInteger(queue['pending']) &&
          isNonNegativeInteger(queue['processed']) &&
          isNonNegativeInteger(queue['totalQueued'])))
    ) {
      return output as unknown as UnavailableResult;
    }
  }
  if (
    !(
      isRecord(output) &&
      hasSemanticNotices(output) &&
      isPositiveInteger(output['budget']) &&
      typeof output['chunkContentIncludedInContext'] === 'boolean' &&
      Array.isArray(output['chunks']) &&
      output['chunks'].every(isSemanticChunk) &&
      typeof output['context'] === 'string' &&
      typeof output['embeddingSetId'] === 'string' &&
      isPositiveInteger(output['limit']) &&
      isNonNegativeInteger(output['remainingTokens']) &&
      isNonNegativeInteger(output['skipped']) &&
      isNonNegativeInteger(output['skippedForMissingSourceRange']) &&
      isFiniteNumber(output['threshold']) &&
      isNonNegativeInteger(output['totalTokens'])
    )
  ) {
    throw new ToolProjectionInputRejectedError(
      'queryEmbeddingSpace model projection received a malformed result'
    );
  }
  const result = output as unknown as SemanticResult;
  if (
    (result.truncated === true && !result.hint?.trim()) ||
    result.totalTokens + result.remainingTokens !== result.budget ||
    result.skippedForMissingSourceRange > result.skipped ||
    result.chunkContentIncludedInContext !== result.chunks.length > 0 ||
    (result.chunks.length === 0 ? result.context.length > 0 : result.context.length === 0)
  ) {
    throw new ToolProjectionInputRejectedError(
      'queryEmbeddingSpace model projection received a malformed result'
    );
  }
  return result;
}

function isHybridItem(value: unknown): value is HybridItem {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value['chunkIndex']) &&
    typeof value['content'] === 'string' &&
    isOptionalString(value['fileName']) &&
    isOptionalString(value['filePath']) &&
    (value['ftsRank'] === undefined || isFiniteNumber(value['ftsRank'])) &&
    typeof value['id'] === 'string' &&
    isPositiveInteger(value['position']) &&
    isOptionalString(value['rootName']) &&
    isFiniteNumber(value['rrfScore']) &&
    (value['sourceCount'] === 1 || value['sourceCount'] === 2 || value['sourceCount'] === 3) &&
    (value['vectorSimilarity'] === undefined || isFiniteNumber(value['vectorSimilarity']))
  );
}

function parseHybridResult(output: unknown): HybridResult {
  if (
    !(
      isRecord(output) &&
      typeof output['embeddingSetId'] === 'string' &&
      isFiniteNumber(output['ftsWeight']) &&
      isOptionalString(output['hint']) &&
      isRecord(output['metadata']) &&
      isNonNegativeInteger(output['metadata']['ftsResultCount']) &&
      isNonNegativeInteger(output['metadata']['fusedResultCount']) &&
      isFiniteNumber(output['metadata']['totalMs']) &&
      output['metadata']['totalMs'] >= 0 &&
      isNonNegativeInteger(output['metadata']['vectorResultCount']) &&
      Array.isArray(output['results']) &&
      output['results'].every(isHybridItem) &&
      isOptionalString(output['root']) &&
      typeof output['truncated'] === 'boolean' &&
      isFiniteNumber(output['vectorWeight'])
    )
  ) {
    throw new ToolProjectionInputRejectedError(
      'hybridSearch model projection received a malformed result'
    );
  }
  const result = output as unknown as HybridResult;
  if (
    result.results.length > result.metadata.fusedResultCount ||
    result.results.some((item, index) => item.position !== index + 1) ||
    (result.truncated && (!result.hint || result.hint.trim().length === 0))
  ) {
    throw new ToolProjectionInputRejectedError(
      'hybridSearch model projection received a malformed result'
    );
  }
  return result;
}

function clipPath(value: string): string {
  return clipProjectionMiddle(escapePathLineBreaks(value), MAX_PATH_CHARS, 'path');
}

function semanticHeader(result: SemanticResult): string {
  return (
    `semantic | status=available | set=${clipEnd(result.embeddingSetId, MAX_ID_CHARS, 'set-id')}` +
    ` | chunks=${result.chunks.length} | tokens=${result.totalTokens}/${result.budget}` +
    ` | remaining=${result.remainingTokens} | skipped=${result.skipped}` +
    ` | missing_ranges=${result.skippedForMissingSourceRange} | threshold=${result.threshold}`
  );
}

function semanticScores(result: SemanticResult): string | null {
  if (result.chunks.length === 0) {
    return null;
  }
  return `scores: ${result.chunks
    .map((chunk) => `${chunk.rank}=${chunk.score ?? 'unavailable'}`)
    .join(',')}`;
}

function fitSemanticContext(
  result: SemanticResult,
  fixed: readonly string[],
  domainModelResultCharBudget: number
): string[] {
  if (result.context.length === 0) {
    return [...fixed];
  }
  const full = [...fixed, ...result.context.split('\n')];
  if (decodedChars(full) <= domainModelResultCharBudget) {
    return full;
  }
  const codePoints = Array.from(result.context);
  const refinement =
    'refine: reuse brainstrike.queryEmbeddingSpace with a narrower query, root, maxChunks, or tokenBudget';
  let low = 0;
  let high = codePoints.length;
  while (low < high) {
    const midpoint = Math.ceil((low + high) / 2);
    const candidate = [
      ...fixed,
      codePoints.slice(0, midpoint).join(''),
      `projection_omitted_context_chars=${codePoints.length - midpoint}`,
      refinement,
    ];
    if (decodedChars(candidate) <= domainModelResultCharBudget) {
      low = midpoint;
    } else {
      high = midpoint - 1;
    }
  }
  const fitted = [
    ...fixed,
    codePoints.slice(0, low).join(''),
    `projection_omitted_context_chars=${codePoints.length - low}`,
    refinement,
  ];
  if (decodedChars(fitted) > domainModelResultCharBudget) {
    throw new RangeError('queryEmbeddingSpace model projection cannot fit required metadata');
  }
  return fitted;
}

function projectUnavailable(
  result: UnavailableResult,
  domainModelResultCharBudget: number
): WorkspaceRetrievalTextModelOutput {
  const index = result.workspaceIndex;
  const lines = [
    `semantic | status=unavailable | reason=${result.reason}` +
      ` | set=${index.embeddingSetId ?? 'unavailable'} | enabled=${index.enabled}` +
      ` | paused=${index.paused} | index_state=${index.statusState ?? 'unavailable'}`,
    `message: ${clipEnd(result.message, MAX_MESSAGE_CHARS, 'message')}`,
    ...(index.blockedReason ? [`blocked_reason: ${singleLine(index.blockedReason)}`] : []),
    ...(index.lastError
      ? [`last_error: ${clipEnd(index.lastError, MAX_MESSAGE_CHARS, 'last-error')}`]
      : []),
    ...(index.queueProgress
      ? [
          `queue: processed=${index.queueProgress.processed}/${index.queueProgress.totalQueued}` +
            ` | pending=${index.queueProgress.pending} | failed=${index.queueProgress.failed}`,
        ]
      : []),
  ];
  if (decodedChars(lines) > domainModelResultCharBudget) {
    throw new RangeError('queryEmbeddingSpace unavailable projection exceeds its budget');
  }
  return output(lines);
}

export function projectQueryEmbeddingSpaceModelOutput(
  raw: unknown,
  domainModelResultCharBudget = MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET
): WorkspaceRetrievalTextModelOutput {
  const result = parseSemanticResult(raw);
  if ('status' in result) {
    return projectUnavailable(result, domainModelResultCharBudget);
  }
  const scores = semanticScores(result);
  return output(
    fitSemanticContext(
      result,
      [
        semanticHeader(result),
        ...(scores ? [scores] : []),
        ...(result.hint ? [`hint: ${clipEnd(result.hint, MAX_MESSAGE_CHARS, 'hint')}`] : []),
      ],
      domainModelResultCharBudget
    )
  );
}

function hybridHeader(result: HybridResult, kept: number): string {
  const root = result.root ? ` | root=${clipEnd(result.root, MAX_ROOT_CHARS, 'root-name')}` : '';
  return (
    `hybrid | set=${clipEnd(result.embeddingSetId, MAX_ID_CHARS, 'set-id')}` +
    ` | shown=${kept}/${result.metadata.fusedResultCount}${root}` +
    ` | truncated=${result.truncated} | vector=${result.metadata.vectorResultCount}` +
    ` | fts=${result.metadata.ftsResultCount} | fused=${result.metadata.fusedResultCount}` +
    ` | weights=${result.vectorWeight}:${result.ftsWeight} | total_ms=${result.metadata.totalMs}`
  );
}

function hybridItemLines(item: HybridItem): string[] {
  const path = item.filePath ?? item.fileName ?? 'unavailable';
  const root = item.rootName ? `[${clipEnd(item.rootName, MAX_ROOT_CHARS, 'root-name')}] ` : '';
  return [
    `#${item.position} ${root}${clipPath(path)} | chunk=${item.chunkIndex}` +
      ` | sources=${item.sourceCount} | rrf=${item.rrfScore}` +
      ` | vector=${item.vectorSimilarity ?? 'unavailable'}` +
      ` | fts=${item.ftsRank ?? 'unavailable'}` +
      ` | id=${clipEnd(item.id, MAX_ID_CHARS, 'chunk-id')}`,
    `excerpt: ${clipEnd(item.content, MAX_EXCERPT_CHARS, 'excerpt')}`,
  ];
}

function buildHybridLines(
  result: HybridResult,
  itemLines: readonly string[],
  kept: number
): string[] {
  const omitted = result.results.length - kept;
  return [
    hybridHeader(result, kept),
    ...itemLines,
    ...(omitted > 0 ? [`projection_omitted_results=${omitted}`] : []),
    ...(result.hint ? [`hint: ${clipEnd(result.hint, MAX_MESSAGE_CHARS, 'hint')}`] : []),
  ];
}

export function projectHybridSearchModelOutput(
  raw: unknown,
  domainModelResultCharBudget = MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET
): WorkspaceRetrievalTextModelOutput {
  const result = parseHybridResult(raw);
  const keptLines: string[] = [];
  let kept = 0;
  for (const item of result.results) {
    const itemLines = hybridItemLines(item);
    const candidate = buildHybridLines(result, [...keptLines, ...itemLines], kept + 1);
    if (decodedChars(candidate) > domainModelResultCharBudget) {
      break;
    }
    keptLines.push(...itemLines);
    kept += 1;
  }
  const lines = buildHybridLines(result, keptLines, kept);
  if (decodedChars(lines) > domainModelResultCharBudget) {
    throw new RangeError('hybridSearch model projection cannot fit required metadata');
  }
  return output(lines);
}
