/** Read the host's single execution identity shape, separate from model arguments. */
export function readToolCallId(args: readonly unknown[]): string | undefined {
  return readExecutionIdentity(args, 'toolCallId');
}

/** Native thread IDs are globally unique; never substitute persona or root identity. */
export function readToolExecutionThreadId(args: readonly unknown[]): string | undefined {
  return readExecutionIdentity(args, 'threadId');
}

function readExecutionIdentity(
  args: readonly unknown[],
  key: 'toolCallId' | 'threadId'
): string | undefined {
  const context = args[1];
  if (!(context && typeof context === 'object' && key in context)) {
    return;
  }
  const candidate: unknown = Reflect.get(context, key);
  return typeof candidate === 'string' && candidate.trim().length > 0 ? candidate : undefined;
}
