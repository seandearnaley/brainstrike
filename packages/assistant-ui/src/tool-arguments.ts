export interface ToolArguments {
  readonly args: unknown;
  readonly argsText?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hasStructuredArguments(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (isRecord(value)) {
    return Object.keys(value).length > 0;
  }
  return value !== undefined && value !== null;
}

function serializeArguments(args: unknown, argsText: unknown): string {
  if (typeof argsText === 'string' && argsText.trim().length > 0) {
    return argsText;
  }
  const serialized = JSON.stringify(args);
  if (serialized === undefined) {
    throw new Error('Tool arguments could not be serialized for display.');
  }
  return serialized;
}

export function collectToolArgumentsByCallId(
  messages: readonly unknown[]
): ReadonlyMap<string, ToolArguments> {
  const byCallId = new Map<string, ToolArguments>();
  for (const message of messages) {
    if (!(isRecord(message) && Array.isArray(message['content']))) {
      continue;
    }
    for (const part of message['content']) {
      if (!(isRecord(part) && part['type'] === 'tool-call')) {
        continue;
      }
      const toolCallId = part['toolCallId'];
      const args = part['args'];
      if (!(typeof toolCallId === 'string' && hasStructuredArguments(args))) {
        continue;
      }
      byCallId.set(toolCallId, {
        args,
        argsText: serializeArguments(args, part['argsText']),
      });
    }
  }
  return byCallId;
}

export function shouldUseRememberedToolArguments(args: unknown): boolean {
  return !hasStructuredArguments(args);
}
