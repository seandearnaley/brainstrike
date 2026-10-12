import type { HostToolInvocation } from '@brainstrike/agent-host';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { logger } = vi.hoisted(() => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('@brainstrike/logging', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/logging')>()),
  createLogger: vi.fn(() => logger),
}));

vi.mock('../src/native-tools/read-workspace-file-model-projection.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../src/native-tools/read-workspace-file-model-projection.js')
    >();
  return {
    ...actual,
    projectReadWorkspaceFileModelOutput: vi.fn(actual.projectReadWorkspaceFileModelOutput),
  };
});

import { CEILING_SCALED_TOOL_RESULT_BUDGET } from '@brainstrike/agent';
import {
  buildGrepSupersededMarker,
  collectSupersessionCandidates,
  grepProjectionHeaderPrefix,
  type PersistedToolInvocation,
  projectGrepSearchModelOutput,
  projectReadWorkspaceFileModelOutput,
  readProjectionHeaderPrefix,
  resetMalformedProjectionMemoForTests,
  selectHostProjectionRewrites,
  setMalformedWarnMemoCapForTests,
  TOOL_PROJECTION_REWRITE_BATCH_THRESHOLD_CHARS,
} from '../src/native-tools/index.js';

// The UNMOCKED projector builds fixtures: the host commits the PROJECTED model
// output, so fixtures must too, without polluting the mocked projector's calls.
const { projectReadWorkspaceFileModelOutput: actualProjectRead } = await vi.importActual<
  typeof import('../src/native-tools/read-workspace-file-model-projection.js')
>('../src/native-tools/read-workspace-file-model-projection.js');

const CEILING_BUDGET = CEILING_SCALED_TOOL_RESULT_BUDGET.domainModelResultCharBudget;
const LARGE_READ_CONTENT_CHARS = 5000;
const READS_TO_CROSS_BATCH_THRESHOLD = 14;
const READ_SUPERSEDED_MALFORMED =
  'Skipping malformed persisted read result during supersession detection';

type NativeToolId = (typeof NATIVE_TOOL_ID)[keyof typeof NATIVE_TOOL_ID];

/** Provider-facing (sanitized) tool name, as the host commits it. */
function committedName(toolId: NativeToolId): string {
  return toolId.replace('.', '_');
}

function call(args: {
  readonly id: string;
  readonly input: Record<string, unknown>;
  readonly modelOutput: unknown;
  readonly output: unknown;
  readonly toolId: NativeToolId;
}): HostToolInvocation {
  return {
    args: args.input,
    modelOutput: args.modelOutput,
    output: args.output,
    toolCallId: args.id,
    toolName: committedName(args.toolId),
  };
}

function readOutput(contentLength: number, overrides: Record<string, unknown> = {}) {
  return {
    approxOutputTokens: contentLength,
    content: 'x'.repeat(contentLength),
    endLine: 100,
    nextCursor: null,
    omittedChars: 0,
    path: 'src/a.ts',
    rootId: 'root-a',
    rootName: 'workspace',
    size: contentLength,
    startLine: 1,
    tokenCount: null,
    totalLines: 100,
    truncated: false,
    ...overrides,
  };
}

function readCall(
  id: string,
  output: Record<string, unknown>,
  input: Record<string, unknown> = { endLine: 100, path: 'src/a.ts', root: 'root-a', startLine: 1 }
): HostToolInvocation {
  return call({
    id,
    input,
    // Mirror the runtime: project under the ceiling scaled budget.
    modelOutput: actualProjectRead(output, CEILING_BUDGET),
    output,
    toolId: NATIVE_TOOL_ID.readWorkspaceFile,
  });
}

/** A read whose committed result lacks the file identity supersession needs. */
function malformedReadCall(id: string, output: Record<string, unknown>): HostToolInvocation {
  return call({
    id,
    input: { path: 'src/a.ts' },
    modelOutput: { type: 'text', value: JSON.stringify(output) },
    output,
    toolId: NATIVE_TOOL_ID.readWorkspaceFile,
  });
}

function largeReads(args: {
  readonly idPrefix: string;
  readonly input?: Record<string, unknown>;
  readonly outputOverrides?: Record<string, unknown>;
}): HostToolInvocation[] {
  return Array.from({ length: READS_TO_CROSS_BATCH_THRESHOLD }, (_, index) =>
    readCall(
      `${args.idPrefix}-${index}`,
      readOutput(LARGE_READ_CONTENT_CHARS, args.outputOverrides),
      args.input
    )
  );
}

function writeCall(id: string, path: string): HostToolInvocation {
  return call({
    id,
    input: { content: 'replacement', path, root: 'root-a' },
    modelOutput: { type: 'text', value: `wrote ${path}` },
    output: { bytesWritten: 11, created: false, path, rootId: 'root-a', rootName: 'workspace' },
    toolId: NATIVE_TOOL_ID.writeWorkspaceFile,
  });
}

function grepOutput(fileCount: number, nameRepeat: number) {
  return {
    candidatesTruncated: false,
    files: Array.from({ length: fileCount }, (_, index) => ({
      firstLine: 1,
      matchCount: 1,
      path: `src/${String(index).padStart(3, '0')}-${'long-name-'.repeat(nameRepeat)}.ts`,
      source: 'live' as const,
    })),
    liveEngine: 'ripgrep' as const,
    offset: 0,
    outputMode: 'files' as const,
    scanLimited: false,
    totalFiles: fileCount,
    totalMatches: fileCount,
    truncated: false,
  };
}

function grepCall(id: string, input: Record<string, unknown>, output: unknown): HostToolInvocation {
  return call({
    id,
    input,
    modelOutput: projectGrepSearchModelOutput(output, CEILING_BUDGET),
    output,
    toolId: NATIVE_TOOL_ID.grepSearch,
  });
}

/** The just-finished call is the run's current turn, as the legacy trigger was. */
function select(invocations: readonly HostToolInvocation[]) {
  const current = invocations.at(-1);
  return selectHostProjectionRewrites({
    currentTurnToolCallIds: new Set(current ? [current.toolCallId] : []),
    invocations,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetMalformedProjectionMemoForTests();
});

describe('stale-read supersession through the host rewrite policy', () => {
  it('writes nothing below 64 KiB and commits one batch at or above it', () => {
    const small = readCall('call-small', readOutput(1000));
    expect(select([small, readCall('call-new-small', readOutput(2000))])).toEqual([]);

    const rewrites = select([
      small,
      ...largeReads({ idPrefix: 'call-large' }),
      readCall('call-new-large', readOutput(2000)),
    ]);
    expect(rewrites).toHaveLength(READS_TO_CROSS_BATCH_THRESHOLD + 1);
    expect(rewrites.every((rewrite) => rewrite.kind === 'supersession')).toBe(true);
    expect(
      rewrites.every((rewrite) => rewrite.markerText.startsWith(readProjectionHeaderPrefix()))
    ).toBe(true);
  });

  it('builds both marker families from their canonical replay prefix helpers', () => {
    expect(buildGrepSupersededMarker('files').startsWith(grepProjectionHeaderPrefix('files'))).toBe(
      true
    );
    expect(readProjectionHeaderPrefix()).toBe('read ');
  });

  it('treats a successful file edit as superseding every earlier read of that file', () => {
    const rewrites = select([
      ...largeReads({ idPrefix: 'read-before-edit' }),
      writeCall('edit-new', 'src/a.ts'),
    ]);

    expect(rewrites).toHaveLength(READS_TO_CROSS_BATCH_THRESHOLD);
    expect(
      rewrites.filter((rewrite) => rewrite.markerText.includes('file was modified after this read'))
    ).toEqual([
      {
        kind: 'supersession',
        markerText:
          'read src/a.ts lines 1-100/100 [superseded — file was modified after this read — re-read before relying on it]',
        supersededByToolCallId: 'edit-new',
        toolCallId: `read-before-edit-${READS_TO_CROSS_BATCH_THRESHOLD - 1}`,
      },
    ]);
  });

  it('does not merge same-name paths from different canonical workspace roots', () => {
    const fillerInput = { endLine: 100, path: 'src/filler.ts', root: 'root-a', startLine: 1 };
    const rewrites = select([
      readCall('read-root-a', readOutput(LARGE_READ_CONTENT_CHARS, { rootId: 'root-a' }), {
        endLine: 100,
        path: 'src/a.ts',
        root: 'root-a',
        startLine: 1,
      }),
      readCall('read-root-b', readOutput(1000, { rootId: 'root-b' }), {
        endLine: 100,
        path: 'src/a.ts',
        root: 'root-b',
        startLine: 1,
      }),
      ...largeReads({
        idPrefix: 'root-filler-old',
        input: fillerInput,
        outputOverrides: { path: 'src/filler.ts', rootId: 'root-a' },
      }),
      readCall(
        'root-filler-new',
        readOutput(1000, { path: 'src/filler.ts', rootId: 'root-a' }),
        fillerInput
      ),
      writeCall('root-trigger', 'src/other.ts'),
    ]);

    expect(rewrites).toHaveLength(READS_TO_CROSS_BATCH_THRESHOLD);
    expect(rewrites.map((rewrite) => rewrite.toolCallId)).not.toContain('read-root-a');
  });

  it('never lets a committed unchanged-read stub supersede a real earlier read', () => {
    const fillerInput = { endLine: 100, path: 'src/filler.ts', root: 'root-a', startLine: 1 };
    const rewrites = select([
      readCall('read-real', readOutput(LARGE_READ_CONTENT_CHARS)),
      readCall(
        'read-dedup-stub',
        readOutput(44, {
          content: 'File unchanged since the previous identical read.',
          dedup: true,
        })
      ),
      ...largeReads({
        idPrefix: 'filler-old',
        input: fillerInput,
        outputOverrides: { path: 'src/filler.ts' },
      }),
      readCall('filler-new', readOutput(1000, { path: 'src/filler.ts' }), fillerInput),
      writeCall('unrelated-trigger', 'src/other.ts'),
    ]);

    expect(rewrites).toHaveLength(READS_TO_CROSS_BATCH_THRESHOLD);
    expect(rewrites.map((rewrite) => rewrite.toolCallId)).not.toContain('read-real');
  });

  it('uses the unambiguous multi-root label in collapsed read markers', () => {
    const multiRoot = {
      ambiguousRootNames: [],
      openRoots: 2,
      rootId: 'root-a',
      rootName: 'workspace',
    };
    const rewrites = select([
      ...largeReads({ idPrefix: 'read-labeled-root', outputOverrides: multiRoot }),
      readCall('read-labeled-root-later', readOutput(1000, multiRoot)),
    ]);

    expect(rewrites).toHaveLength(READS_TO_CROSS_BATCH_THRESHOLD);
    expect(
      rewrites.every((rewrite) => /^read workspace:src\/a\.ts lines/u.test(rewrite.markerText))
    ).toBe(true);
  });

  it('supersedes earlier greps only for the same normalized pattern and scope', () => {
    const output = grepOutput(200, 15);
    const input = { filePaths: ['src'], outputMode: 'files', pattern: 'needle' };
    const oldGreps = Array.from({ length: 20 }, (_, index) =>
      grepCall(`grep-old-${index}`, input, output)
    );
    const rewrites = select([
      grepCall('grep-other-scope', { ...input, filePaths: ['lib'] }, output),
      ...oldGreps,
      grepCall('grep-new', input, { ...output, files: [] }),
    ]);

    expect(rewrites.map((rewrite) => rewrite.toolCallId)).toEqual(
      oldGreps.map((grep) => grep.toolCallId)
    );
    expect(
      rewrites.every((rewrite) =>
        rewrite.markerText.startsWith(grepProjectionHeaderPrefix('files'))
      )
    ).toBe(true);
  });

  it('normalizes wrapped committed grep arguments before supersession matching', () => {
    const output = grepOutput(300, 20);
    const input = { filePaths: ['src'], outputMode: 'files', pattern: 'wrapped-needle' };
    const rewrites = select([
      ...Array.from({ length: 20 }, (_, index) =>
        grepCall(`grep-wrapped-${index}`, { context: input }, output)
      ),
      grepCall('grep-wrapped-new', input, { ...output, files: [] }),
    ]);

    expect(rewrites).toHaveLength(20);
  });

  it('matches successful committed greps with null omitted filePaths', () => {
    const output = grepOutput(300, 20);
    const rewrites = select([
      ...Array.from({ length: 20 }, (_, index) =>
        grepCall(
          `grep-null-scope-${index}`,
          { filePaths: null, outputMode: 'files', pattern: 'null-scope-needle' },
          output
        )
      ),
      grepCall(
        'grep-malformed-required-pattern',
        { filePaths: null, outputMode: 'files', pattern: null },
        output
      ),
      grepCall(
        'grep-null-scope-new',
        { outputMode: 'files', pattern: 'null-scope-needle' },
        { ...output, files: [] }
      ),
    ]);

    expect(rewrites).toHaveLength(20);
  });

  it('batches reads by projected replay size rather than larger raw JSON size', () => {
    const markerChars = JSON.stringify({
      type: 'text',
      value: 'read src/a.ts lines 1-100/100 [superseded — see the later read of this file]',
    }).length;
    let thresholdFixture:
      | { contentLength: number; count: number; output: ReturnType<typeof readOutput> }
      | undefined;
    for (let count = 10; count <= 20 && !thresholdFixture; count += 1) {
      for (let contentLength = 4000; contentLength <= 5500; contentLength += 1) {
        const candidate = readOutput(contentLength);
        const rawReclaimable =
          (JSON.stringify({ type: 'json', value: candidate }).length - markerChars) * count;
        const projectedReclaimable =
          (JSON.stringify(actualProjectRead(candidate)).length - markerChars) * count;
        if (
          rawReclaimable >= TOOL_PROJECTION_REWRITE_BATCH_THRESHOLD_CHARS &&
          projectedReclaimable < TOOL_PROJECTION_REWRITE_BATCH_THRESHOLD_CHARS
        ) {
          thresholdFixture = { contentLength, count, output: candidate };
          break;
        }
      }
    }
    if (!thresholdFixture) {
      throw new Error('Expected a read fixture that crosses only the raw-JSON threshold.');
    }
    const { count, output } = thresholdFixture;

    expect(
      select([
        ...Array.from({ length: count }, (_, index) =>
          call({
            id: `read-raw-only-threshold-${index}`,
            input: { endLine: 100, path: 'src/a.ts', root: 'root-a', startLine: 1 },
            modelOutput: actualProjectRead(output),
            output,
            toolId: NATIVE_TOOL_ID.readWorkspaceFile,
          })
        ),
        readCall('read-after-raw-only-threshold', readOutput(1000)),
      ])
    ).toEqual([]);
  });

  it('measures winning read candidates from the committed model output, never by re-projecting', () => {
    const rewrites = select([
      ...largeReads({ idPrefix: 'read-old' }),
      readCall('read-new', readOutput(5)),
    ]);

    // BST-1249: committed invocations carry the exact model-facing projection;
    // re-projecting the raw result would re-apply the DEFAULT domain budget,
    // which is smaller than the loop-guard/scaled budget some runtimes used.
    expect(rewrites).toHaveLength(READS_TO_CROSS_BATCH_THRESHOLD);
    expect(projectReadWorkspaceFileModelOutput).not.toHaveBeenCalled();
  });

  it('does not brand a large read as malformed when its projection exceeds the default budget (BST-1249)', () => {
    // Content projecting to ~10k chars was legitimately projected at runtime
    // under a scaled budget (up to the ceiling), but re-projection under the
    // default budget threw RangeError and mislabeled the record malformed.
    select([readCall('read-large', readOutput(10_500)), readCall('read-new', readOutput(5))]);

    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('malformed committed record warnings', () => {
  it('warns once per malformed committed read invocation during a scan', () => {
    select([
      malformedReadCall('read-malformed', { content: 'missing identity' }),
      readCall('read-later-1', readOutput(3, { path: 'src/one.ts' })),
      readCall('read-later-2', readOutput(3, { path: 'src/two.ts' })),
      readCall('read-later-3', readOutput(5, { path: 'src/three.ts' })),
      writeCall('write-later-4', 'src/four.ts'),
    ]);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      READ_SUPERSEDED_MALFORMED,
      expect.objectContaining({ toolCallId: 'read-malformed' })
    );
  });

  it('warns once per malformed record across scans, not once per scan (BST-1248)', () => {
    const malformed = malformedReadCall('read-malformed-cross-scan', { content: 'no identity' });
    for (const id of ['read-new-1', 'read-new-2', 'read-new-3']) {
      select([malformed, readCall(id, readOutput(5, { path: 'src/other.ts' }))]);
    }

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      READ_SUPERSEDED_MALFORMED,
      expect.objectContaining({ toolCallId: 'read-malformed-cross-scan' })
    );
  });

  it('still warns for each distinct malformed record (BST-1248 memo must not over-suppress)', () => {
    select([
      malformedReadCall('read-malformed-a', { content: 'missing identity' }),
      malformedReadCall('read-malformed-b', { content: 'also malformed' }),
      readCall('read-new-1', readOutput(5, { path: 'src/other.ts' })),
    ]);

    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      READ_SUPERSEDED_MALFORMED,
      expect.objectContaining({ toolCallId: 'read-malformed-a' })
    );
    expect(logger.warn).toHaveBeenCalledWith(
      READ_SUPERSEDED_MALFORMED,
      expect.objectContaining({ toolCallId: 'read-malformed-b' })
    );
  });

  it('keeps a warn-memoized record acting as a superseder on later scans (warn-dedup only)', () => {
    // A(1-10) is superseded ONLY by X(5-20); X parses fine for detection but
    // its stricter projection contract throws (missing content/size/...), so
    // X warns once via readCandidate when L(15-30) supersedes it. If the memo
    // gated the PARSE instead of just the warn, scan 2 would drop X.read and
    // A would silently lose its only superseder (review finding on BST-1248).
    // X has no committed projection, which the host entry never forwards, so
    // this pins collectSupersessionCandidates' own contract directly.
    const persisted = (id: string, output: Record<string, unknown>): PersistedToolInvocation => ({
      args: { endLine: 100, path: 'src/a.ts', root: 'root-a', startLine: 1 },
      modelOutput: actualProjectRead(output, CEILING_BUDGET),
      result: output,
      toolCallId: id,
      toolName: NATIVE_TOOL_ID.readWorkspaceFile,
    });
    const readX: PersistedToolInvocation = {
      args: { endLine: 20, path: 'src/a.ts', root: 'root-a', startLine: 5 },
      modelOutput: undefined,
      result: {
        endLine: 20,
        path: 'src/a.ts',
        rootId: 'root-a',
        rootName: 'workspace',
        startLine: 5,
        totalLines: 100,
      },
      toolCallId: 'read-x',
      toolName: NATIVE_TOOL_ID.readWorkspaceFile,
    };
    const invocations = [
      persisted('read-a', readOutput(5, { endLine: 10, startLine: 1 })),
      readX,
      persisted('read-l', readOutput(4, { endLine: 30, startLine: 15 })),
    ];
    const scan = (toolCallId: string) =>
      collectSupersessionCandidates({
        current: {
          ...persisted(toolCallId, readOutput(5, { path: 'src/other.ts' })),
          modelOutput: undefined,
        },
        invocations,
      });

    scan('read-new-1');
    const second = scan('read-new-2');

    // Both scans attempt candidates for A (superseded by X, measured from its
    // committed model output — no re-projection) and X (superseded by L, whose
    // ceiling re-projection throws): one re-projection call per scan.
    expect(projectReadWorkspaceFileModelOutput).toHaveBeenCalledTimes(2);
    expect(second).toEqual([
      expect.objectContaining({ supersededByToolCallId: 'read-x', toolCallId: 'read-a' }),
    ]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      READ_SUPERSEDED_MALFORMED,
      expect.objectContaining({ toolCallId: 'read-x' })
    );
  });

  it('announces suppression once at the distinct-record ceiling instead of an eviction cliff', () => {
    setMalformedWarnMemoCapForTests(2);
    const history = [
      malformedReadCall('bad-1', { content: 'no identity' }),
      malformedReadCall('bad-2', { content: 'no identity' }),
      malformedReadCall('bad-3', { content: 'no identity' }),
    ];
    for (const id of ['read-new-1', 'read-new-2']) {
      select([...history, readCall(id, readOutput(5, { path: 'src/other.ts' }))]);
    }

    // Two first-encounter warns, one suppression announcement, then silence —
    // scan 2 must not re-warn (the eviction-cliff failure mode).
    expect(logger.warn).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledWith(
      'Further malformed persisted tool record warnings are suppressed',
      expect.objectContaining({ distinctRecordCap: 2 })
    );
  });
});
