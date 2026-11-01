/**
 * Privacy-safe metadata attached to a raw search-tool result in process.
 *
 * The WeakMap keeps telemetry out of the tool result's serialized/displayed
 * shape. Only booleans cross the later stream boundary; patterns, paths, and
 * result content are structurally impossible to retain here.
 */
export interface ToolCallTelemetryMetadata {
  /**
   * BST-1247: substrate flags recorded SEPARATELY from `truncated`.
   * `truncated` means exactly "model-facing output was clipped" — folding
   * candidate caps or a ripgrep timeout into it made
   * the self-improvement waste ranking blame the model for infrastructure
   * failure it cannot influence.
   */
  readonly candidatesTruncated?: boolean;
  /** Live-pass engine for search tools ('ripgrep' | 'js-files' | 'skipped'). */
  readonly engine?: 'js-files' | 'ripgrep' | 'skipped';
  readonly isPaginationFollowup: boolean;
  readonly scanLimited?: boolean;
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
