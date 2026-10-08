import {
  attachToolCallTelemetryMetadata,
  type GlobWorkspaceInput,
  type GrepSearchInput,
} from '@brainstrike/agent';
import type { GlobWorkspaceToolResult } from './glob-workspace-tool.js';
import type { GrepToolResult } from './grep-search-result-contract.js';

/**
 * BST-1247: `truncated` records exactly "model-facing output was clipped".
 * Substrate degradation (rg → capped JS walk, candidate caps, walk caps) is
 * recorded in its own fields — the pre-split OR fold made the 2026-08 audit's
 * waste ranking blame the model for infrastructure failure: all 40 glob calls
 * were "truncated", including 33 zero-match results with nothing to clip.
 */
export function attachGrepSearchTelemetry(
  input: Pick<GrepSearchInput, 'offset'>,
  result: GrepToolResult
): GrepToolResult {
  const zeroMatch =
    result.outputMode === 'files' ? result.totalFiles === 0 : result.totalMatches === 0;
  return attachToolCallTelemetryMetadata(result, {
    candidatesTruncated: result.candidatesTruncated,
    engine: result.liveEngine,
    isPaginationFollowup: (input.offset ?? 0) > 0,
    scanLimited: result.scanLimited,
    truncated: result.truncated,
    zeroMatch,
  });
}

export function attachGlobWorkspaceTelemetry(
  input: Pick<GlobWorkspaceInput, 'offset'>,
  result: GlobWorkspaceToolResult
): GlobWorkspaceToolResult {
  return attachToolCallTelemetryMetadata(result, {
    candidatesTruncated: false,
    isPaginationFollowup: (input.offset ?? 0) > 0,
    scanLimited: result.scanLimited,
    truncated: result.truncated,
    zeroMatch: result.totalMatches === 0,
  });
}
