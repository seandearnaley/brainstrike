import { MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET } from '@brainstrike/agent';
import { isValidWebSearchCitationUrl } from './web-search-citation-url';

export interface WebSearchTextModelOutput {
  type: 'text';
  value: string;
}

interface WebSearchItem {
  snippet: string;
  title: string;
  url: string;
}

interface WebSearchResult {
  available: boolean;
  count: number;
  error?: string;
  hint?: string;
  message?: string;
  query: string;
  results: WebSearchItem[];
  totalResults: number;
  truncated: boolean;
}

const MAX_MESSAGE_CHARS = 1200;
const MAX_QUERY_CHARS = 1600;
const MAX_QUERY_LINE_SERIALIZED_CHARS = 2600;
const MAX_SNIPPET_CHARS = 320;
const MAX_TITLE_CHARS = 220;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isWebSearchItem(value: unknown): value is WebSearchItem {
  return (
    isRecord(value) &&
    typeof value['snippet'] === 'string' &&
    typeof value['title'] === 'string' &&
    value['title'].length > 0 &&
    typeof value['url'] === 'string' &&
    isValidWebSearchCitationUrl(value['url'])
  );
}

function parseWebSearchResult(raw: unknown): WebSearchResult {
  if (
    !(
      isRecord(raw) &&
      typeof raw['available'] === 'boolean' &&
      isNonNegativeInteger(raw['count']) &&
      isOptionalString(raw['error']) &&
      isOptionalString(raw['hint']) &&
      isOptionalString(raw['message']) &&
      typeof raw['query'] === 'string' &&
      raw['query'].length <= 2000 &&
      Array.isArray(raw['results']) &&
      raw['results'].every(isWebSearchItem) &&
      isNonNegativeInteger(raw['totalResults']) &&
      typeof raw['truncated'] === 'boolean'
    )
  ) {
    throw new TypeError('webSearch model projection received a malformed result');
  }

  const result = raw as unknown as WebSearchResult;
  const hasError = result.error !== undefined;
  const hasMessage = result.message !== undefined;
  const hasHint = result.hint !== undefined;
  const validUnavailable =
    !result.available &&
    result.count === 0 &&
    result.results.length === 0 &&
    result.totalResults === 0 &&
    !result.truncated &&
    !hasError &&
    hasMessage &&
    result.message?.trim().length !== 0 &&
    !hasHint;
  const validError =
    result.available &&
    hasError &&
    result.error?.trim().length !== 0 &&
    result.count === 0 &&
    result.results.length === 0 &&
    result.totalResults === 0 &&
    !result.truncated &&
    !hasMessage &&
    !hasHint;
  const validSuccess =
    result.available &&
    !hasError &&
    !hasMessage &&
    result.count === result.results.length &&
    result.totalResults >= result.count &&
    result.truncated === result.count < result.totalResults &&
    (result.truncated
      ? hasHint && result.hint?.trim().length !== 0
      : !hasHint && result.count === result.totalResults);

  if (!(validUnavailable || validError || validSuccess)) {
    throw new TypeError('webSearch model projection received a malformed result');
  }
  return result;
}

function singleLine(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function clipEnd(value: string, maxChars: number, label: string): string {
  const normalized = singleLine(value);
  const codePoints = Array.from(normalized);
  if (codePoints.length <= maxChars) {
    return normalized;
  }
  return `${codePoints.slice(0, maxChars).join('')}…[${
    codePoints.length - maxChars
  } ${label} chars omitted]`;
}

function serializedQueryLineChars(rendered: string): number {
  return JSON.stringify(output([`query: ${rendered}`])).length;
}

function renderQuery(query: string): string {
  const codePoints = Array.from(query);
  const full = JSON.stringify(query);
  if (
    codePoints.length <= MAX_QUERY_CHARS &&
    serializedQueryLineChars(full) <= MAX_QUERY_LINE_SERIALIZED_CHARS
  ) {
    return full;
  }

  let low = 0;
  let high = Math.min(codePoints.length, MAX_QUERY_CHARS);
  while (low < high) {
    const midpoint = Math.ceil((low + high) / 2);
    const candidate = `${JSON.stringify(codePoints.slice(0, midpoint).join(''))}…[${
      codePoints.length - midpoint
    } query chars omitted]`;
    if (serializedQueryLineChars(candidate) <= MAX_QUERY_LINE_SERIALIZED_CHARS) {
      low = midpoint;
    } else {
      high = midpoint - 1;
    }
  }
  return `${JSON.stringify(codePoints.slice(0, low).join(''))}…[${
    codePoints.length - low
  } query chars omitted]`;
}

function output(lines: readonly string[]): WebSearchTextModelOutput {
  return { type: 'text', value: lines.join('\n') };
}

function serializedChars(lines: readonly string[]): number {
  return JSON.stringify(output(lines)).length;
}

function status(result: WebSearchResult): 'available' | 'error' | 'unavailable' {
  if (!result.available) {
    return 'unavailable';
  }
  if (result.error !== undefined) {
    return 'error';
  }
  return 'available';
}

function header(result: WebSearchResult, kept: number): string {
  return (
    `web-search | status=${status(result)} | shown=${kept}/${result.totalResults}` +
    ` | truncated=${result.truncated}`
  );
}

function itemLines(item: WebSearchItem, rank: number): string[] {
  return [
    `#${rank} title: ${clipEnd(item.title, MAX_TITLE_CHARS, 'title')}`,
    `url: ${JSON.stringify(item.url)}`,
    `snippet: ${clipEnd(item.snippet, MAX_SNIPPET_CHARS, 'snippet')}`,
  ];
}

function buildLines(
  result: WebSearchResult,
  projectedItems: readonly string[],
  kept: number
): string[] {
  const projectionOmitted = result.results.length - kept;
  return [
    header(result, kept),
    `query: ${renderQuery(result.query)}`,
    ...projectedItems,
    ...(projectionOmitted > 0 ? [`projection_omitted_results=${projectionOmitted}`] : []),
    ...(result.message
      ? [`message: ${clipEnd(result.message, MAX_MESSAGE_CHARS, 'message')}`]
      : []),
    ...(result.error ? [`error: ${clipEnd(result.error, MAX_MESSAGE_CHARS, 'error')}`] : []),
    ...(result.hint ? [`hint: ${clipEnd(result.hint, MAX_MESSAGE_CHARS, 'hint')}`] : []),
    ...(projectionOmitted > 0
      ? ['refine: reuse brainstrike.webSearch with a narrower query or lower maxResults']
      : []),
  ];
}

export function projectWebSearchModelOutput(raw: unknown): WebSearchTextModelOutput {
  const result = parseWebSearchResult(raw);
  const projectedItems: string[] = [];
  let kept = 0;

  for (const [index, item] of result.results.entries()) {
    const nextItem = itemLines(item, index + 1);
    const candidate = buildLines(result, [...projectedItems, ...nextItem], kept + 1);
    if (serializedChars(candidate) > MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET) {
      break;
    }
    projectedItems.push(...nextItem);
    kept += 1;
  }

  const lines = buildLines(result, projectedItems, kept);
  if (serializedChars(lines) > MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET) {
    throw new RangeError('webSearch model projection cannot fit required metadata');
  }
  return output(lines);
}
