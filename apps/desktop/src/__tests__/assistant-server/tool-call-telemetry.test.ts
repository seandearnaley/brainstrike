import {
  type GlobWorkspaceInput,
  type GrepSearchInput,
  readToolCallTelemetryMetadata,
} from '@brainstrike/agent';
import type {
  GlobWorkspaceToolResult,
  GrepToolResult,
} from '@brainstrike/host-capabilities/native-tools';
import { describe, expect, it } from 'vitest';
import {
  attachGlobWorkspaceTelemetry,
  attachGrepSearchTelemetry,
} from '../../assistant-server/tool-call-telemetry';

describe('search tool-call telemetry extraction', () => {
  it('keeps truncated = output clipping only and reports substrate flags separately (BST-1247)', () => {
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

    // Pre-BST-1247 this recorded truncated: true, folding the substrate cap
    // into the output-clipping flag — which made waste_score blame the model
    // for infrastructure degradation it cannot influence.
    expect(readToolCallTelemetryMetadata(attachGrepSearchTelemetry(input, result))).toEqual({
      candidatesTruncated: true,
      engine: 'skipped',
      isPaginationFollowup: true,
      scanLimited: false,
      truncated: false,
      zeroMatch: true,
    });
  });

  it('records a degraded-walk grep with unclipped output as engine js-walk, not truncated', () => {
    const input: GrepSearchInput = { offset: 0, pattern: 'PRIVATE_PATTERN' };
    const result = {
      candidatesTruncated: false,
      files: [],
      liveEngine: 'js-walk',
      offset: 0,
      outputMode: 'files',
      scanLimited: true,
      totalFiles: 0,
      totalMatches: 0,
      truncated: false,
    } satisfies GrepToolResult;

    expect(readToolCallTelemetryMetadata(attachGrepSearchTelemetry(input, result))).toEqual({
      candidatesTruncated: false,
      engine: 'js-walk',
      isPaginationFollowup: false,
      scanLimited: true,
      truncated: false,
      zeroMatch: true,
    });
  });

  it('still reports genuine grep output clipping as truncated', () => {
    const input: GrepSearchInput = { offset: 0, pattern: 'PRIVATE_PATTERN' };
    const result = {
      candidatesTruncated: false,
      files: [
        {
          firstLine: 12,
          matchCount: 3,
          path: 'src/a.ts',
          rootId: 'root',
          rootName: 'workspace',
          source: 'index',
        },
      ],
      liveEngine: 'ripgrep',
      offset: 0,
      outputMode: 'files',
      scanLimited: false,
      totalFiles: 80,
      totalMatches: 200,
      truncated: true,
    } satisfies GrepToolResult;

    expect(readToolCallTelemetryMetadata(attachGrepSearchTelemetry(input, result))).toEqual({
      candidatesTruncated: false,
      engine: 'ripgrep',
      isPaginationFollowup: false,
      scanLimited: false,
      truncated: true,
      zeroMatch: false,
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
    // scanLimited no longer masquerades as output truncation (BST-1247): all
    // 40 glob calls in the 2026-08 audit were "truncated", including 33
    // zero-match results with nothing to clip.
    expect(metadata).toEqual({
      candidatesTruncated: false,
      isPaginationFollowup: false,
      scanLimited: true,
      truncated: false,
      zeroMatch: false,
    });
    expect(JSON.stringify(metadata)).not.toMatch(/PRIVATE_PATTERN|PRIVATE_PATH/);
  });
});
