import {
  decodeToolOutputArtifactContent,
  isToolOutputArtifactReference,
} from '../../../../packages/assistant-contract/src/tool-output-artifact.ts';

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected a direct public tool-result object.');
  }
  return value as Record<string, unknown>;
}

export function toolPayload(message: unknown): Record<string, unknown> {
  const content = record(message)['content'];
  if (typeof content !== 'string') {
    throw new Error('Expected the actual model-visible JSON tool content.');
  }
  const value: unknown = JSON.parse(content);
  return record(value);
}

export function requireDiscoveredProducer(message: unknown): string {
  const catalog = toolPayload(message);
  if (
    catalog['total'] !== 1 ||
    catalog['nextOffset'] !== null ||
    !Array.isArray(catalog['tools']) ||
    catalog['tools'].length !== 1
  ) {
    throw new Error('The actual fixture catalog must contain exactly one complete tool entry.');
  }
  const name = record(catalog['tools'][0])['name'];
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('Fixture discovery supplied no actual tool name.');
  }
  return name;
}

export interface ArtifactPage {
  readonly content: string;
  readonly endByte: number;
  readonly format: 'text' | 'json';
  readonly next: { readonly input: { readonly cursor: string }; readonly tool: string };
  readonly offsetByte: 0;
}

export function requireArtifactPage(message: unknown): ArtifactPage {
  const page = toolPayload(message);
  const next = record(page['next']);
  const input = record(next['input']);
  if (
    typeof page['content'] !== 'string' ||
    (page['format'] !== 'text' && page['format'] !== 'json') ||
    page['offsetByte'] !== 0 ||
    typeof page['endByte'] !== 'number' ||
    page['endByte'] <= 0 ||
    page['endByte'] > 8000 ||
    Buffer.byteLength(page['content']) !== page['endByte'] ||
    typeof next['tool'] !== 'string' ||
    next['tool'].length === 0 ||
    Object.keys(input).length !== 1 ||
    typeof input['cursor'] !== 'string' ||
    input['cursor'].length === 0
  ) {
    throw new Error('Expected the actual bounded initial page and its advertised reader action.');
  }
  return {
    content: page['content'],
    endByte: page['endByte'],
    format: page['format'],
    next: { input: { cursor: input['cursor'] }, tool: next['tool'] },
    offsetByte: 0,
  };
}

type ReaderAction = ArtifactPage['next'];
export type ArtifactContinuation = {
  readonly content: string;
  readonly endByte: number;
  readonly format: 'json';
  readonly offsetByte: number;
} & (
  | { readonly next: ReaderAction; readonly complete?: never }
  | { readonly complete: true; readonly next?: never }
);

export function requireArtifactContinuation(
  message: unknown,
  previousEndByte: number
): ArtifactContinuation {
  const page = toolPayload(message);
  if (
    typeof page['content'] !== 'string' ||
    (page['contentEncoding'] !== undefined && page['contentEncoding'] !== 'json-string')
  ) {
    throw new Error('Expected canonical artifact page content encoding.');
  }
  const content = decodeToolOutputArtifactContent(page['content'], page['contentEncoding']);
  const endByte = page['endByte'];
  if (
    page['format'] !== 'json' ||
    page['offsetByte'] !== previousEndByte ||
    !Number.isSafeInteger(previousEndByte) ||
    previousEndByte < 0 ||
    typeof endByte !== 'number' ||
    !Number.isSafeInteger(endByte) ||
    endByte <= previousEndByte ||
    endByte - previousEndByte > 8000 ||
    Buffer.byteLength(content) !== endByte - previousEndByte
  ) {
    throw new Error('Expected a strictly advancing contiguous UTF-8 artifact page.');
  }
  const base = { content, endByte, format: 'json' as const, offsetByte: previousEndByte };
  if (page['complete'] === true && page['next'] === undefined) {
    return { ...base, complete: true };
  }
  if (page['complete'] !== undefined) {
    throw new Error('Artifact page completion and continuation are mutually exclusive.');
  }
  const next = record(page['next']);
  const input = record(next['input']);
  if (
    typeof next['tool'] !== 'string' ||
    next['tool'].length === 0 ||
    Object.keys(input).length !== 1 ||
    typeof input['cursor'] !== 'string' ||
    input['cursor'].length === 0
  ) {
    throw new Error('Expected only the exact advertised paging action.');
  }
  return { ...base, next: { input: { cursor: input['cursor'] }, tool: next['tool'] } };
}

export function reconstructArtifactSearch(messages: readonly unknown[]): Record<string, unknown> {
  let endByte = 0;
  let content = '';
  let complete = false;
  for (const message of messages) {
    if (complete) {
      throw new Error('Received an artifact page after EOF.');
    }
    const page = requireArtifactContinuation(message, endByte);
    content += page.content;
    endByte = page.endByte;
    complete = page.complete === true;
  }
  if (!complete) {
    throw new Error('Artifact search recovery did not reach EOF.');
  }
  const result = record(JSON.parse(content));
  if (
    result['type'] !== 'artifact_search' ||
    !isToolOutputArtifactReference(result['artifactRef'])
  ) {
    throw new Error('Recovered content is not the actual artifact search result.');
  }
  return result;
}
