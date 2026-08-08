import {
  type GlobWorkspaceInput,
  type GrepSearchInput,
  readToolCallTelemetryMetadata,
} from '@brainstrike/agent';
import { describe, expect, it } from 'vitest';
import type { GlobWorkspaceToolResult } from '../../assistant-server/glob-workspace-tool';
import type { GrepToolResult } from '../../assistant-server/grep-search-result-contract';
import {
  attachGlobWorkspaceTelemetry,
  attachGrepSearchTelemetry,
} from '../../assistant-server/tool-call-telemetry';

describe('search tool-call telemetry extraction', () => {
  it('derives grep zero-match, request pagination, and all typed truncation flags', () => {
    // The wider real-call-site input type (with `pattern`) is used here, and
    // only its `offset` field is ever read — proving the pattern cannot leak
    // structurally, not merely by omission at the call site.
    const input: GrepSearchInput = { offset: 9, pattern: 'PRIVATE_PATTERN' };
    const result = {
      candidatesTruncated: true,
      files: [],
      liveEngine: 'skipped',
      offset: 9,
      outputMode: 'files',
      scanLimited: false,
      totalFiles: 0,
      totalMatches: 0,
      truncated: false,
    } satisfies GrepToolResult;

    expect(readToolCallTelemetryMetadata(attachGrepSearchTelemetry(input, result))).toEqual({
      isPaginationFollowup: true,
      truncated: true,
      zeroMatch: true,
    });
  });

  it('derives glob metrics without retaining the pattern or matched paths', () => {
    const input: GlobWorkspaceInput = { offset: 0, pattern: 'PRIVATE_PATTERN' };
    const result = {
      count: 1,
      matches: [{ path: '/PRIVATE_PATH.ts', rootId: 'root', rootName: 'workspace' }],
      offset: 0,
      scanLimited: true,
      totalMatches: 1,
      truncated: false,
    } satisfies GlobWorkspaceToolResult;

    const metadata = readToolCallTelemetryMetadata(attachGlobWorkspaceTelemetry(input, result));
    expect(metadata).toEqual({ isPaginationFollowup: false, truncated: true, zeroMatch: false });
    expect(JSON.stringify(metadata)).not.toMatch(/PRIVATE_PATTERN|PRIVATE_PATH/);
  });
});
