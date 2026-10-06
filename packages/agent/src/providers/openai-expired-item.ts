/** BST-1927 / ADR-0014: an expired stored item requires an explicit user decision. */
export class OpenAIStoredItemExpiredError extends Error {
  readonly code = 'openai_stored_item_expired';
  readonly retryable = false;

  constructor(cause: unknown) {
    super(
      'An OpenAI stored item has expired. Confirm replaying the conversation before continuing.',
      { cause }
    );
    this.name = 'OpenAIStoredItemExpiredError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readErrorEnvelope(value: Record<string, unknown>): unknown {
  const body = value['responseBody'];
  if (typeof body !== 'string' || (value['statusCode'] !== 400 && value['statusCode'] !== 404)) {
    return;
  }
  try {
    const envelope: unknown = JSON.parse(body);
    return isRecord(envelope) ? envelope['error'] : undefined;
  } catch {
    return;
  }
}

/** Inspect structured SDK errors and their causes without exposing request/response bodies. */
export function isOpenAIStoredItemExpiredError(error: unknown): boolean {
  const visited = new WeakSet<object>();
  function visit(value: unknown): boolean {
    if (!isRecord(value) || visited.has(value)) {
      return false;
    }
    visited.add(value);
    if (value instanceof OpenAIStoredItemExpiredError) {
      return true;
    }
    const code = value['code'];
    if (code === 'item_expired' || code === 'item_not_found') {
      return true;
    }
    // The installed Responses adapter retains OpenAI's JSON error envelope
    // as APICallError.responseBody. Never match arbitrary prompt content.
    if (visit(readErrorEnvelope(value))) {
      return true;
    }
    const message = value['message'];
    if (
      typeof message === 'string' &&
      /(?:item|response).*\bexpired\b|item with id.*not found/i.test(message)
    ) {
      return true;
    }
    return visit(value['error']) || visit(value['cause']);
  }
  return visit(error);
}

export function classifyOpenAIStoredItemError(error: unknown): unknown {
  return error instanceof OpenAIStoredItemExpiredError || !isOpenAIStoredItemExpiredError(error)
    ? error
    : new OpenAIStoredItemExpiredError(error);
}
