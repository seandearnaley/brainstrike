import {
  attachToolCallTelemetryMetadata,
  type GlobWorkspaceInput,
  type GrepSearchInput,
} from '@brainstrike/agent';
import type { GlobWorkspaceToolResult } from './glob-workspace-tool';
import type { GrepToolResult } from './grep-search-result-contract';

export function attachGrepSearchTelemetry(
  input: Pick<GrepSearchInput, 'offset'>,
  result: GrepToolResult
): GrepToolResult {
  const zeroMatch =
    result.outputMode === 'files' ? result.totalFiles === 0 : result.totalMatches === 0;
  return attachToolCallTelemetryMetadata(result, {
    isPaginationFollowup: (input.offset ?? 0) > 0,
    truncated: result.truncated || result.candidatesTruncated || result.scanLimited,
    zeroMatch,
  });
}

export function attachGlobWorkspaceTelemetry(
  input: Pick<GlobWorkspaceInput, 'offset'>,
  result: GlobWorkspaceToolResult
): GlobWorkspaceToolResult {
  return attachToolCallTelemetryMetadata(result, {
    isPaginationFollowup: (input.offset ?? 0) > 0,
    truncated: result.truncated || result.scanLimited,
    zeroMatch: result.totalMatches === 0,
  });
}
