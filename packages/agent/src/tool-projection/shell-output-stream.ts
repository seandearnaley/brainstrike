import { SHELL_OUTPUT_STREAM_PART_TYPE } from '@brainstrike/assistant-contract/shell-output';

/**
 * The Mastra fullStream part `type` used to carry a live shell-output slice,
 * owned by the contract. A tool streams incremental output through Mastra's
 * `writer.custom(chunk)`, which places `chunk` on the agent fullStream VERBATIM
 * (unlike `writer.write`, which wraps it as a `tool-output` part that would
 * collide with subagent delegation handling and masquerade as a successful tool
 * result), so {@link mapShellOutputStreamPart} picks it out by this `type`.
 */
export { SHELL_OUTPUT_STREAM_PART_TYPE };

/** The minimal shape of Mastra's tool `writer` we depend on (`ToolStream`). */
export interface ShellOutputWriter {
  custom: (data: { type: string } & Record<string, unknown>) => Promise<void>;
}

/**
 * Emit one live shell-output slice through a tool's Mastra `writer`. Keeps the
 * wire shape in a single place so the desktop tool and the stream mapper cannot
 * drift. The chunk carries its own `toolCallId` (`writer.custom` does not inject
 * one, unlike `writer.write`) so the renderer can attach it to the right card.
 */
export function writeShellOutputChunk(
  writer: ShellOutputWriter,
  part: { chunk: string; stream: 'stdout' | 'stderr'; toolCallId: string; truncated?: boolean }
): Promise<void> {
  return writer.custom({
    chunk: part.chunk,
    stream: part.stream,
    toolCallId: part.toolCallId,
    type: SHELL_OUTPUT_STREAM_PART_TYPE,
    ...(part.truncated ? { truncated: true } : {}),
  });
}
