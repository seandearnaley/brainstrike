/**
 * Read the tool-call id Mastra passes alongside a tool's input.
 *
 * ONE reader, deliberately. Mastra has carried this id in two places across
 * versions (`agent.toolCallId` and a bare `toolCallId`), and it had drifted
 * into three byte-identical copies — in the artifact-settlement wrapper, the
 * execution guard, and the hook wrapper. When Mastra moves it again, three
 * copies means one gets fixed and the others quietly start returning
 * `undefined`, which for the duration recorder degrades to "no measurement" —
 * the one failure mode that looks exactly like working correctly.
 *
 * The argument position is Mastra's: input first, execution context second.
 */
export function readToolCallId(args: readonly unknown[]): string | undefined {
  const context = args[1];
  if (!(context && typeof context === 'object')) {
    return;
  }
  const record = context as { agent?: { toolCallId?: unknown }; toolCallId?: unknown };
  const candidate = record.agent?.toolCallId ?? record.toolCallId;
  return typeof candidate === 'string' && candidate.trim().length > 0 ? candidate : undefined;
}
