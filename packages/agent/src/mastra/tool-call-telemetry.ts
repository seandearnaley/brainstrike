/**
 * Privacy-safe metadata attached to a raw search-tool result in process.
 *
 * The WeakMap keeps telemetry out of the tool result's serialized/displayed
 * shape. Only booleans cross the later stream boundary; patterns, paths, and
 * result content are structurally impossible to retain here.
 */
export interface ToolCallTelemetryMetadata {
  readonly isPaginationFollowup: boolean;
  readonly truncated: boolean;
  readonly zeroMatch: boolean;
}

const metadataByOutput = new WeakMap<object, ToolCallTelemetryMetadata>();

export function attachToolCallTelemetryMetadata<T extends object>(
  output: T,
  metadata: ToolCallTelemetryMetadata
): T {
  metadataByOutput.set(output, metadata);
  return output;
}

export function readToolCallTelemetryMetadata(
  output: unknown
): ToolCallTelemetryMetadata | undefined {
  return output !== null && (typeof output === 'object' || typeof output === 'function')
    ? metadataByOutput.get(output)
    : undefined;
}

export function transferToolCallTelemetryMetadata(source: unknown, target: unknown): void {
  const metadata = readToolCallTelemetryMetadata(source);
  if (metadata && target !== null && (typeof target === 'object' || typeof target === 'function')) {
    metadataByOutput.set(target, metadata);
  }
}
