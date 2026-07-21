import {
  MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET,
  NATIVE_TOOL_RESULT_CHAR_BUDGET,
} from '@brainstrike/agent';
import { describe, expect, it } from 'vitest';
import {
  projectGlobWorkspaceModelOutput,
  projectGrepSearchModelOutput,
} from '../../assistant-server/workspace-search-model-projections';

function serializedChars(value: unknown): number {
  return JSON.stringify(value).length;
}

describe('workspace search model projections', () => {
  it('projects a grep file survey as compact root-qualified lines with an advancing offset', () => {
    const raw = {
      candidatesTruncated: false,
      files: [
        {
          firstLine: 11,
          matchCount: 3,
          path: '/src/alpha.ts',
          rootId: 'root-a',
          rootName: 'alpha',
          source: 'both',
        },
        {
          firstLine: 27,
          matchCount: 1,
          path: '/src/beta.ts',
          rootId: 'root-b',
          rootName: 'beta',
          source: 'live',
        },
      ],
      hint: 'Showing 2 of 30 matching files. Continue with offset: 12.',
      liveEngine: 'ripgrep',
      offset: 10,
      outputMode: 'files',
      scanLimited: false,
      totalFiles: 30,
      totalMatches: 44,
      truncated: true,
    };

    const projected = projectGrepSearchModelOutput(raw);

    expect(projected).toEqual({
      type: 'text',
      value: [
        'grep files | page=11-12/30 | matches=44 | live=ripgrep | candidates_truncated=false | scan_limited=false',
        '[alpha|root-a] /src/alpha.ts:11 | matches=3 | source=both',
        '[beta|root-b] /src/beta.ts:27 | matches=1 | source=live',
        'continue: reuse the prior brainstrike.grepSearch input; Showing 2 of 30 matching files. Continue with offset: 12.',
      ].join('\n'),
    });
    expect(serializedChars(projected)).toBeLessThan(serializedChars(raw));
  });

  it('projects grep content without repeated JSON keys and makes clipped context explicit', () => {
    const raw = {
      candidatesTruncated: true,
      hint: 'Showing matches 1-1 of 18. Continue with offset: 1 or narrow with filePaths.',
      liveEngine: 'js-walk',
      liveNote: 'ripgrep unavailable; bounded JavaScript walk used',
      matches: [
        {
          after: [`after ${'a'.repeat(400)}`],
          before: [`before ${'b'.repeat(400)}`],
          line: 42,
          lineText: `needle ${'x'.repeat(600)}`,
          path: '/src/large.ts',
          rootId: 'root-a',
          rootName: 'alpha',
          source: 'live',
        },
      ],
      offset: 0,
      outputMode: 'content',
      scanLimited: true,
      skippedMissingLineMetadata: 2,
      totalMatches: 18,
      truncated: true,
    };

    const projected = projectGrepSearchModelOutput(raw);

    expect(projected.type).toBe('text');
    expect(projected.value).toContain(
      'grep content | page=1-1/18+ | live=js-walk | candidates_truncated=true | scan_limited=true | skipped_missing_line_metadata=2'
    );
    expect(projected.value).toContain('[alpha|root-a] /src/large.ts:42 | source=live');
    expect(projected.value).toContain('match: needle ');
    expect(projected.value).toContain('chars omitted]');
    expect(projected.value).toContain('note: ripgrep unavailable; bounded JavaScript walk used');
    expect(projected.value).toContain(
      'continue: reuse the prior brainstrike.grepSearch input; Showing matches 1-1 of 18. Continue with offset: 1 or narrow with filePaths.'
    );
    expect(serializedChars(projected)).toBeLessThan(serializedChars(raw));
  });

  it('fits a maximum grep page to the domain ceiling while retaining a continuation', () => {
    const raw = {
      candidatesTruncated: false,
      files: Array.from({ length: 50 }, (_, index) => ({
        firstLine: index + 1,
        matchCount: index + 2,
        path: `/very/long/generated/path/${String(index).padStart(3, '0')}-${'x'.repeat(80)}.ts`,
        rootId: `root-${index % 2}`,
        rootName: index % 2 === 0 ? 'alpha' : 'beta',
        source: 'both',
      })),
      liveEngine: 'ripgrep',
      offset: 0,
      outputMode: 'files',
      scanLimited: false,
      totalFiles: 50,
      totalMatches: 20_000,
      truncated: false,
    };

    const projected = projectGrepSearchModelOutput(raw);

    expect(serializedChars(raw)).toBeGreaterThan(MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET);
    expect(serializedChars(raw)).toBeLessThanOrEqual(NATIVE_TOOL_RESULT_CHAR_BUDGET);
    expect(serializedChars(projected)).toBeLessThanOrEqual(
      MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET
    );
    expect(serializedChars(projected)).toBeLessThan(serializedChars(raw) * 0.7);
    expect(projected.value).toMatch(
      /continue: reuse the prior brainstrike\.grepSearch input with offset=\d+$/
    );
  });

  it('projects glob matches compactly and retains scan-limit truth', () => {
    const raw = {
      count: 2,
      hint: 'Showing matches 5-6 of 12+. Continue with offset: 6, or narrow the pattern because the workspace scan limit was reached.',
      matches: [
        { path: '/src/a.ts', rootId: 'root-a', rootName: 'alpha' },
        { path: '/src/b.ts', rootId: 'root-b', rootName: 'beta' },
      ],
      offset: 4,
      scanLimited: true,
      totalMatches: 12,
      truncated: true,
    };

    const projected = projectGlobWorkspaceModelOutput(raw);

    expect(projected).toEqual({
      type: 'text',
      value: [
        'glob | page=5-6/12+ | scan_limited=true',
        '[alpha|root-a] /src/a.ts',
        '[beta|root-b] /src/b.ts',
        'continue: reuse the prior brainstrike.globWorkspace input; Showing matches 5-6 of 12+. Continue with offset: 6, or narrow the pattern because the workspace scan limit was reached.',
      ].join('\n'),
    });
  });

  it('fits a maximum glob page to the domain ceiling with an advancing offset', () => {
    const raw = {
      count: 60,
      matches: Array.from({ length: 60 }, (_, index) => ({
        path: `/very/long/generated/path/${String(index).padStart(3, '0')}-${'x'.repeat(80)}.ts`,
        rootId: `root-${index % 2}`,
        rootName: index % 2 === 0 ? 'alpha' : 'beta',
      })),
      offset: 0,
      scanLimited: false,
      totalMatches: 60,
      truncated: false,
    };

    const projected = projectGlobWorkspaceModelOutput(raw);

    expect(serializedChars(raw)).toBeGreaterThan(MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET);
    expect(serializedChars(raw)).toBeLessThanOrEqual(NATIVE_TOOL_RESULT_CHAR_BUDGET);
    expect(serializedChars(projected)).toBeLessThanOrEqual(
      MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET
    );
    expect(serializedChars(projected)).toBeLessThan(serializedChars(raw) * 0.7);
    expect(projected.value).toMatch(
      /continue: reuse the prior brainstrike\.globWorkspace input with offset=\d+$/
    );
  });

  it('fits a boundary-overflowing final item before enforcing producer guidance', () => {
    const grepProjected = projectGrepSearchModelOutput({
      candidatesTruncated: false,
      liveEngine: 'ripgrep',
      matches: Array.from({ length: 2 }, (_, index) => ({
        after: ['a'.repeat(2000)],
        before: ['b'.repeat(2000)],
        line: index + 1,
        lineText: 'x'.repeat(2000),
        path: `/${'nested/'.repeat(180)}file-${index}.ts`,
        rootId: 'r'.repeat(500),
        rootName: 'workspace'.repeat(100),
        source: 'both',
      })),
      offset: 0,
      outputMode: 'content',
      scanLimited: false,
      skippedMissingLineMetadata: 0,
      totalMatches: 3,
      truncated: true,
    });
    const globProjected = projectGlobWorkspaceModelOutput({
      count: 7,
      matches: Array.from({ length: 7 }, (_, index) => ({
        path: `/${'nested/'.repeat(300)}file-${index}.ts`,
        rootId: 'root-a',
        rootName: 'alpha',
      })),
      offset: 0,
      scanLimited: true,
      totalMatches: 8,
      truncated: true,
    });

    expect(serializedChars(grepProjected)).toBeLessThanOrEqual(
      MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET
    );
    expect(grepProjected.value).toMatch(
      /continue: reuse the prior brainstrike\.grepSearch input with offset=\d+$/
    );
    expect(serializedChars(globProjected)).toBeLessThanOrEqual(
      MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET
    );
    expect(globProjected.value).toMatch(
      /continue: reuse the prior brainstrike\.globWorkspace input with offset=\d+$/
    );
  });

  it('clips one oversized path without losing its exact advancing offset', () => {
    const raw = {
      count: 1,
      hint: 'Continue with offset: 8.',
      matches: [{ path: `/${'x'.repeat(7000)}`, rootId: 'root-a', rootName: 'alpha' }],
      offset: 7,
      scanLimited: false,
      totalMatches: 10,
      truncated: true,
    };

    const projected = projectGlobWorkspaceModelOutput(raw);

    expect(projected.value).toContain('path clipped');
    expect(projected.value).toContain(
      'continue: reuse the prior brainstrike.globWorkspace input; Continue with offset: 8.'
    );
  });

  it('narrows instead of emitting a non-advancing offset when only the scan limit is open', () => {
    const projected = projectGlobWorkspaceModelOutput({
      count: 0,
      hint: 'The walk hit its file-visit cap; narrow the pattern to a specific subdirectory.',
      matches: [],
      offset: 12,
      scanLimited: true,
      totalMatches: 12,
      truncated: true,
    });

    expect(projected.value).toContain(
      'continue: reuse the prior brainstrike.globWorkspace input; The walk hit its file-visit cap; narrow the pattern to a specific subdirectory.'
    );
    expect(projected.value.split('\n').at(-1)).not.toContain('offset=');
  });

  it('preserves terminal grep refinement when candidate limits yield an empty page', () => {
    const projected = projectGrepSearchModelOutput({
      candidatesTruncated: true,
      files: [],
      hint:
        'Search limits were reached before this page could return additional matching files. ' +
        'Narrow with filePaths or use a more specific or different pattern; repeating this offset cannot make progress.',
      liveEngine: 'ripgrep',
      offset: 0,
      outputMode: 'files',
      scanLimited: false,
      totalFiles: 0,
      totalMatches: 0,
      truncated: false,
    });

    expect(projected.value).toContain(
      'continue: reuse the prior brainstrike.grepSearch input; Search limits were reached'
    );
    expect(projected.value).toContain('repeating this offset cannot make progress');
    expect(projected.value.split('\n').at(-1)).not.toMatch(
      /(?:Continue with offset:|with offset=)\d+/
    );
  });

  it('advances one producer item when a non-empty raw page could not retain that item', () => {
    const projected = projectGrepSearchModelOutput({
      candidatesTruncated: false,
      files: [],
      hint: 'Continue with offset: 5.',
      liveEngine: 'ripgrep',
      offset: 4,
      outputMode: 'files',
      scanLimited: false,
      totalFiles: 8,
      totalMatches: 8,
      truncated: true,
    });

    expect(projected.value).toContain(
      'continue: reuse the prior brainstrike.grepSearch input; Continue with offset: 5.'
    );
  });

  it('preserves the producer pagination-cap decision instead of synthesizing an empty offset', () => {
    const projected = projectGrepSearchModelOutput({
      candidatesTruncated: false,
      hint: 'Pagination cap reached (50 of 100 matches reachable by offset). Narrow with filePaths.',
      liveEngine: 'ripgrep',
      matches: [
        {
          after: [],
          before: [],
          line: 90,
          lineText: 'needle',
          path: '/src/capped.ts',
          source: 'both',
        },
      ],
      offset: 49,
      outputMode: 'content',
      scanLimited: false,
      skippedMissingLineMetadata: 0,
      totalMatches: 100,
      truncated: true,
    });

    expect(projected.value).toContain(
      'continue: reuse the prior brainstrike.grepSearch input; Pagination cap reached (50 of 100 matches reachable by offset). Narrow with filePaths.'
    );
    expect(projected.value.split('\n').at(-1)).not.toContain('offset=50');
  });

  it('throws visibly for malformed producer results', () => {
    expect(() =>
      projectGrepSearchModelOutput({
        files: [],
        offset: 0,
        outputMode: 'files',
        totalFiles: 'unknown',
      })
    ).toThrow('grepSearch model projection received a malformed result');

    expect(() =>
      projectGlobWorkspaceModelOutput({
        matches: [{ path: '/src/a.ts' }],
        offset: 0,
        totalMatches: 1,
      })
    ).toThrow('globWorkspace model projection received a malformed result');

    expect(() =>
      projectGrepSearchModelOutput({
        candidatesTruncated: false,
        files: [],
        hint: 7,
        liveEngine: 'ripgrep',
        offset: 0,
        outputMode: 'files',
        scanLimited: false,
        totalFiles: 1,
        totalMatches: 1,
        truncated: true,
      })
    ).toThrow('grepSearch model projection received a malformed result');
  });
});
