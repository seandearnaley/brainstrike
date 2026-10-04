import type {
  ModelProviderRequest,
  ModelProviderScript,
  ScriptedToolCall,
} from '../../e2e/utils/model-provider-shim.ts';
import {
  type ArtifactPage,
  reconstructArtifactSearch,
  requireArtifactContinuation,
  requireArtifactPage,
  requireDiscoveredProducer,
  toolPayload,
} from './artifact-evidence.ts';
import { canonicalArtifactReplayTexts, isObservedArtifactReplay } from './artifact-replay.ts';

type Stage = 'discover' | 'load' | 'produce' | 'search' | 'page' | 'complete';
interface Response {
  readonly content: string;
  readonly name: string;
  readonly role: 'tool';
  readonly toolCallId: string;
}
export interface ArtifactFlowSnapshot {
  readonly initialPage: ArtifactPage | undefined;
  readonly recovered: Record<string, unknown> | undefined;
  readonly responses: readonly {
    readonly stage: Stage;
    readonly message: Response;
    readonly requestIndex: number;
  }[];
  readonly stage: Stage;
}
export interface ArtifactFlow {
  readonly select: (request: ModelProviderRequest) => ModelProviderScript;
  readonly snapshot: () => ArtifactFlowSnapshot;
}

function response(value: unknown): Response {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('role' in value) ||
    value.role !== 'tool' ||
    !('tool_call_id' in value) ||
    typeof value.tool_call_id !== 'string' ||
    !value.tool_call_id ||
    !('name' in value) ||
    typeof value.name !== 'string' ||
    !('content' in value) ||
    typeof value.content !== 'string'
  ) {
    throw new Error('Artifact flow requires an actual named tool response and call ID.');
  }
  return {
    content: value.content,
    name: value.name,
    role: 'tool',
    toolCallId: value.tool_call_id,
  };
}

function validateRecovered(
  recovered: Record<string, unknown>,
  initialPage: ArtifactPage,
  producerBytes: Buffer,
  marker: string
): void {
  const reference = recovered['artifactRef'] as Record<string, unknown>;
  const matches = recovered['matches'];
  const match: unknown = Array.isArray(matches) && matches.length === 1 ? matches[0] : undefined;
  if (
    reference['byteLength'] !== producerBytes.length ||
    reference['format'] !== 'json' ||
    recovered['offsetByte'] !== initialPage.endByte ||
    recovered['endByte'] !== producerBytes.length ||
    recovered['searchLimited'] !== false
  ) {
    throw new Error('Recovered search lacks full original provenance or range.');
  }
  if (
    typeof match !== 'object' ||
    match === null ||
    !('line' in match) ||
    match.line !== 1 ||
    !('offsetByte' in match) ||
    match.offsetByte !== initialPage.endByte ||
    !('lineText' in match) ||
    typeof match.lineText !== 'string' ||
    !match.lineText.includes(marker) ||
    match.lineText !== producerBytes.subarray(initialPage.endByte).toString('utf8') ||
    JSON.stringify(recovered).includes('storage_failed')
  ) {
    throw new Error(
      'Recovered search lacks full original provenance, range or actual marker-bearing match.'
    );
  }
}

/** Fixture bounds, independent of how much earlier history the provider retains. */
const MAX_RESPONSES = 16;
const MAX_SEARCH_BYTES = 40_000;

export function createArtifactFlow(options: {
  readonly marker: string;
  readonly serializedProducer: string;
  readonly serverName: string;
}): ArtifactFlow {
  let stage: Stage = 'discover';
  let pending: ScriptedToolCall = {
    arguments: { prefix: options.serverName },
    name: 'list_available_tools',
  };
  let started = false;
  let userKey: string | undefined;
  let initialPage: ArtifactPage | undefined;
  let producerName: string | undefined;
  let recovered: Record<string, unknown> | undefined;
  const seen = new Map<string, Response>();
  const replayTexts = new Set<string>();
  const responses: { stage: Stage; message: Response; requestIndex: number }[] = [];
  const pages: Response[] = [];
  const pagingActions = new Set<string>();
  let endByte = 0;
  const producerBytes = Buffer.from(options.serializedProducer);

  const checkTurn = (request: ModelProviderRequest): number => {
    const humans = request.messages.flatMap((message, index) => {
      if (
        typeof message !== 'object' ||
        message === null ||
        !('role' in message) ||
        message.role !== 'user'
      ) {
        return [];
      }
      if (isObservedArtifactReplay(message, replayTexts)) {
        return [];
      }
      return [{ content: 'content' in message ? message.content : undefined, index }];
    });
    const lastHuman = humans.at(-1);
    if (!lastHuman) {
      throw new Error('Artifact flow has no actual human turn.');
    }
    const key = JSON.stringify(humans.map((human) => human.content));
    if (userKey !== undefined && key !== userKey) {
      throw new Error(
        'Artifact flow crossed into another user turn or received an unowned replay.'
      );
    }
    userKey = key;
    return lastHuman.index;
  };
  const freshResponses = (request: ModelProviderRequest, humanIndex: number): Response[] => {
    const ids = new Set<string>();
    const fresh: Response[] = [];
    for (const message of request.messages.slice(humanIndex + 1)) {
      if (
        typeof message !== 'object' ||
        message === null ||
        !('role' in message) ||
        message.role !== 'tool'
      ) {
        continue;
      }
      const actual = response(message);
      if (ids.has(actual.toolCallId)) {
        throw new Error('Duplicate artifact tool response in one request.');
      }
      ids.add(actual.toolCallId);
      const previous = seen.get(actual.toolCallId);
      if (previous) {
        if (previous.name !== actual.name || previous.content !== actual.content) {
          throw new Error('Artifact tool response changed for an observed call ID.');
        }
        continue;
      }
      fresh.push(actual);
    }
    return fresh;
  };
  const consumePage = (actual: Response): void => {
    if (!initialPage) {
      throw new Error('No original producer provenance was retained.');
    }
    const page = requireArtifactContinuation(actual, endByte);
    if (page.endByte > MAX_SEARCH_BYTES) {
      throw new Error('Artifact fixture search byte bound exceeded.');
    }
    pages.push(actual);
    endByte = page.endByte;
    if (page.next) {
      const action = JSON.stringify(page.next);
      if (page.next.tool !== initialPage.next.tool || pagingActions.has(action)) {
        throw new Error('Artifact paging reader changed or repeated its advertised action.');
      }
      pagingActions.add(action);
      pending = { arguments: page.next.input, name: page.next.tool };
      stage = 'page';
      return;
    }
    recovered = reconstructArtifactSearch(pages);
    validateRecovered(recovered, initialPage, producerBytes, options.marker);
    stage = 'complete';
  };
  const consume = (actual: Response): void => {
    switch (stage) {
      case 'discover':
        producerName = requireDiscoveredProducer(actual);
        pending = { arguments: { toolName: producerName }, name: 'load_tool' };
        stage = 'load';
        break;
      case 'load': {
        const loaded = toolPayload(actual);
        if (!producerName || loaded['success'] !== true || loaded['toolName'] !== producerName) {
          throw new Error('The discovered producer did not load successfully.');
        }
        pending = { arguments: {}, name: producerName };
        stage = 'produce';
        break;
      }
      case 'produce':
        initialPage = requireArtifactPage(actual);
        if (
          initialPage.content.includes(options.marker) ||
          initialPage.content !== producerBytes.subarray(0, initialPage.endByte).toString('utf8')
        ) {
          throw new Error(
            'Actual producer preview differs from the prepared corpus or already contains the deep marker.'
          );
        }
        pagingActions.add(JSON.stringify(initialPage.next));
        pending = {
          arguments: {
            ...initialPage.next.input,
            caseSensitive: true,
            isRegex: false,
            pattern: options.marker,
          },
          name: initialPage.next.tool,
        };
        stage = 'search';
        break;
      case 'search':
      case 'page':
        consumePage(actual);
        break;
      default:
        throw new Error('Unexpected artifact stage.');
    }
  };
  const rememberReplay = (actual: Response): void => {
    if (actual.name !== initialPage?.next.tool) {
      return;
    }
    for (const text of canonicalArtifactReplayTexts(actual)) {
      replayTexts.add(text);
    }
  };
  const accept = (fresh: readonly Response[], requestIndex: number): void => {
    if (!started) {
      if (fresh.length) {
        throw new Error('Artifact flow began with unowned tool responses.');
      }
      started = true;
      return;
    }
    if (stage === 'complete') {
      if (fresh.length) {
        throw new Error('Artifact received a new response after EOF.');
      }
      return;
    }
    if (fresh.length !== 1) {
      throw new Error('Artifact flow requires exactly one new response for its pending call.');
    }
    const actual = fresh[0];
    if (!actual || actual.name !== pending.name) {
      throw new Error('Artifact response does not match the pending tool.');
    }
    if (seen.size >= MAX_RESPONSES) {
      throw new Error('Artifact fixture response bound exceeded.');
    }
    seen.set(actual.toolCallId, actual);
    responses.push({ message: actual, requestIndex, stage });
    consume(actual);
    rememberReplay(actual);
  };
  const select = (request: ModelProviderRequest): ModelProviderScript => {
    const humanIndex = checkTurn(request);
    accept(freshResponses(request, humanIndex), request.requestIndex);
    if (stage === 'complete') {
      return { finalText: 'M2 qualification tools completed' };
    }
    if (!request.toolNames.includes(pending.name)) {
      throw new Error('The next actual artifact tool is absent from active definitions.');
    }
    // Our retained call-ID state selects the next call; pruned history counts do not.
    return {
      finalText: 'M2 qualification tools completed',
      ignorePriorToolResults: true,
      toolCall: pending,
    };
  };
  return { select, snapshot: () => ({ initialPage, recovered, responses: [...responses], stage }) };
}
