/** Per-call timing supplied by the host to the execution guard. */
export interface ToolExecutionDurations {
  /** Elapsed ms for a completed call, or `undefined` if none was recorded. */
  read(toolCallId: string, threadId?: string): number | undefined;
  record(toolCallId: string, durationMs: number, threadId?: string): void;
}
