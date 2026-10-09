import {
  MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET,
  ToolProjectionInputRejectedError,
} from '@brainstrike/agent';
import { refuseExtractUrl, type WebExtractToolResult } from './web-extract-tool.js';
import { decodedWorkspaceTextModelOutputChars } from './workspace-model-projection-helpers.js';

export interface WebExtractTextModelOutput {
  type: 'text';
  value: string;
}

/**
 * Leaves deterministic room for projection labels and the `{type,value}`
 * envelope. Results above this size settle into the exact UTF-8 artifact path
 * before this projector runs.
 */
export const WEB_EXTRACT_INLINE_MAX_SERIALIZED_CHARS = 2400;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isResultItem(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value['content'] === 'string' &&
    typeof value['url'] === 'string' &&
    value['url'].length > 0 &&
    refuseExtractUrl(value['url']) === null
  );
}

function isFailedItem(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value['reason'] === 'string' &&
    value['reason'].length > 0 &&
    typeof value['url'] === 'string' &&
    value['url'].length > 0
  );
}

function parseWebExtractResult(raw: unknown): WebExtractToolResult {
  if (
    !(
      isRecord(raw) &&
      typeof raw['available'] === 'boolean' &&
      isNonNegativeInteger(raw['count']) &&
      isOptionalString(raw['error']) &&
      Array.isArray(raw['failed']) &&
      raw['failed'].every(isFailedItem) &&
      isOptionalString(raw['hint']) &&
      isOptionalString(raw['message']) &&
      Array.isArray(raw['results']) &&
      raw['results'].every(isResultItem) &&
      typeof raw['truncated'] === 'boolean'
    )
  ) {
    throw new ToolProjectionInputRejectedError(
      'webExtract model projection received a malformed result'
    );
  }

  const result = raw as unknown as WebExtractToolResult;
  const hasError = result.error !== undefined;
  const hasMessage = result.message !== undefined;
  const validUnavailable =
    !result.available &&
    result.count === 0 &&
    result.results.length === 0 &&
    !result.truncated &&
    result.hint === undefined &&
    !hasError &&
    hasMessage &&
    result.message?.trim().length !== 0;
  const validError =
    result.available &&
    result.count === 0 &&
    result.results.length === 0 &&
    !result.truncated &&
    result.hint === undefined &&
    hasError &&
    result.error?.trim().length !== 0 &&
    !hasMessage;
  const validSuccess =
    result.available &&
    result.count === result.results.length &&
    !result.truncated &&
    result.hint === undefined &&
    !hasError &&
    !hasMessage;

  if (!(validUnavailable || validError || validSuccess)) {
    throw new ToolProjectionInputRejectedError(
      'webExtract model projection received a malformed result'
    );
  }
  return result;
}

function status(result: WebExtractToolResult): 'available' | 'error' | 'unavailable' {
  if (!result.available) {
    return 'unavailable';
  }
  return result.error === undefined ? 'available' : 'error';
}

function output(lines: readonly string[]): WebExtractTextModelOutput {
  return { type: 'text', value: lines.join('\n') };
}

export function projectWebExtractModelOutput(
  raw: unknown,
  domainModelResultCharBudget = MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET
): WebExtractTextModelOutput {
  const result = parseWebExtractResult(raw);
  if (
    JSON.stringify(result).length >
    Math.min(WEB_EXTRACT_INLINE_MAX_SERIALIZED_CHARS, domainModelResultCharBudget)
  ) {
    return output([
      `web-extract | status=model-output-unavailable | pages=${result.count} | failed=${
        result.failed.length
      } | truncated=false`,
      'error: "Complete webExtract output exceeded the inline model budget, but durable artifact settlement was unavailable for this run. The raw result remains available to the application; start a durable thread before retrying so the model can read an exact continuation."',
    ]);
  }

  const lines = [
    `web-extract | status=${status(result)} | pages=${result.count} | failed=${
      result.failed.length
    } | truncated=false`,
    ...result.results.flatMap((item, index) => [
      `#${index + 1} url: ${JSON.stringify(item.url)}`,
      `content_json: ${JSON.stringify(item.content)}`,
    ]),
    ...result.failed.flatMap((item) => [
      `failed_url: ${JSON.stringify(item.url)}`,
      `failed_reason: ${JSON.stringify(item.reason)}`,
    ]),
    ...(result.message ? [`message: ${JSON.stringify(result.message)}`] : []),
    ...(result.error ? [`error: ${JSON.stringify(result.error)}`] : []),
  ];
  const projected = output(lines);
  if (decodedWorkspaceTextModelOutputChars([projected.value]) > domainModelResultCharBudget) {
    throw new RangeError('webExtract output must settle before model projection');
  }
  return projected;
}
