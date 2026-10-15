/**
 * The thread context map's fold (ADR-0021): what each turn's model received,
 * read only from committed rows.
 *
 * Two owners, no third. The host owns "in the window": each committed
 * `provider.request.prepared` carries a `toolCallWindow`, the tool calls that
 * request carried, as a change from the run's previous request. Each tool's
 * committed raw result owns "which lines", read with the provenance schemas in
 * assistant-contract. This fold never re-derives rewrite, compaction or branch
 * rules; the displayed branch comes from the conversation projection's head.
 */

import type { ExportedMessageRepository } from '@assistant-ui/react';
import {
  parseFileMentionDirectives,
  ReferencedFileFailureSchema,
} from '@brainstrike/assistant-contract';
import {
  applyPromptToolCallWindow,
  type PromptToolCall,
  type PromptToolCallWindow,
} from '@brainstrike/assistant-contract/context-breakdown';
import {
  GrepContentDeliverySchema,
  GrepFilesDeliverySchema,
  HybridDeliverySchema,
  PROJECTION_OMITTED_CONTEXT_CHARS,
  parseGrepContentProjectionPage,
  parseProjectionShownCount,
  ReadDeliverySchema,
  SemanticDeliverySchema,
  StringReplaceDeliverySchema,
  WriteDeliverySchema,
} from '@brainstrike/assistant-contract/context-provenance';
import { denormalizeNativeToolName } from '@brainstrike/assistant-contract/tool-metadata';
import type { CommittedAssistantLogRow } from './committed-assistant-log-projection';

export type ContextSpanKind = 'edit' | 'grep' | 'pinned' | 'read' | 'semantic';

/** One stretch of one file a tool call (or an attachment) delivered. */
export interface ContextSpan {
  /** Index chunk the span names, when the tool reported one. */
  readonly chunkId?: string;
  /** The delivered lines as the model saw them (read gutters removed), for "changed since read". */
  readonly deliveredLines?: readonly string[];
  /** Last line, 1-based inclusive; absent for a whole file or a chunk named only by id. */
  readonly endLine?: number;
  readonly kind: ContextSpanKind;
  /** The model received only part of this span: an excerpt, or text a projection cut. */
  readonly partial?: boolean;
  /** Root-relative path, as the tool reported it. */
  readonly path: string;
  /** A read the tool answered with "unchanged since your last read", not the text again. */
  readonly repeat?: boolean;
  readonly rootId?: string;
  /** Present when the tool named the root only by its display name. */
  readonly rootName?: string;
  readonly startLine?: number;
  readonly wholeFile?: boolean;
}

export interface ContextCall {
  /** An attachment (`@file`) rather than a tool call: in the window for its own run only. */
  readonly attachment: boolean;
  readonly runId: string;
  readonly spans: readonly ContextSpan[];
  readonly status: 'done' | 'failed' | 'pending';
  readonly toolCallId: string;
  /** Canonical tool id (or `@file` for an attachment). */
  readonly toolName: string;
  /** Why a content-bearing result has no spans; absent when mapped or not content-bearing. */
  readonly unmapped?: string;
}

export interface ContextRun {
  /** Runs this run's committed compactions replaced with a summary. */
  readonly compactedRunIds: readonly string[];
  /** False once any of the run's requests was committed without a tool-call window. */
  readonly measured: boolean;
  readonly prompt: string;
  /** Prepared provider requests the run committed. */
  readonly requests: number;
  readonly runId: string;
  /** The tool calls the run's last committed request carried; null before its first. */
  readonly window: ReadonlyMap<string, PromptToolCall> | null;
}

export interface ThreadContextSnapshot {
  readonly calls: ReadonlyMap<string, ContextCall>;
  /** Every committed run, in commit order (all branches). */
  readonly runs: ReadonlyMap<string, ContextRun>;
}

interface MutableCall {
  attachment: boolean;
  /** The last snapshot's view of this call; cleared on any change. */
  frozen?: ContextCall | undefined;
  modelText?: string | undefined;
  output?: unknown;
  runId: string;
  spans?: readonly ContextSpan[] | undefined;
  status: ContextCall['status'];
  toolCallId: string;
  toolName: string;
  unmapped?: string | undefined;
}

interface MutableRun {
  compactedRunIds: string[];
  /** The last snapshot's view of this run; cleared on any change. */
  frozen?: ContextRun | undefined;
  measured: boolean;
  pinIds: string[];
  prompt: string;
  requests: number;
  runId: string;
  window: Map<string, PromptToolCall> | null;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

const READ_GUTTER = /^\d+: ?/u;

interface Extracted {
  readonly spans: readonly ContextSpan[];
  readonly unmapped?: string;
}

const NONE: Extracted = { spans: [] };

function unmapped(reason: string): Extracted {
  return { spans: [], unmapped: reason };
}

function extractRead(call: MutableCall): Extracted {
  const read = ReadDeliverySchema.safeParse(call.output);
  if (!read.success) {
    return unmapped('The read result has an unexpected shape.');
  }
  const result = read.data;
  if (result.endLine < result.startLine) {
    return NONE;
  }
  return {
    spans: [
      {
        deliveredLines: result.content
          .split('\n')
          .slice(0, result.endLine - result.startLine + 1)
          .map((line) => line.replace(READ_GUTTER, '')),
        endLine: result.endLine,
        kind: 'read',
        path: result.path,
        rootId: result.rootId,
        startLine: result.startLine,
        ...(result.dedup ? { repeat: true } : {}),
      },
    ],
  };
}

function extractGrep(call: MutableCall): Extracted {
  if (GrepFilesDeliverySchema.safeParse(call.output).success) {
    return NONE;
  }
  const grep = GrepContentDeliverySchema.safeParse(call.output);
  if (!grep.success) {
    return unmapped('The grep result has an unexpected shape.');
  }
  // Until its model step commits, the delivered page is the whole raw page.
  const page =
    call.modelText === undefined ? undefined : parseGrepContentProjectionPage(call.modelText);
  if (call.modelText !== undefined && !page) {
    return unmapped('The delivered grep page header is unreadable.');
  }
  return {
    spans: grep.data.matches.slice(0, page ? page.kept : undefined).map((match) => ({
      deliveredLines: [...match.before, match.lineText, ...match.after],
      endLine: match.line + match.after.length,
      kind: 'grep' as const,
      path: match.path,
      startLine: match.line - match.before.length,
      ...(match.rootId ? { rootId: match.rootId } : {}),
      ...(match.rootName ? { rootName: match.rootName } : {}),
    })),
  };
}

function extractSemantic(call: MutableCall): Extracted {
  const semantic = SemanticDeliverySchema.safeParse(call.output);
  if (!semantic.success) {
    // An unavailable answer (no index, no vectors) carries no chunks.
    return record(call.output)?.['chunks'] === undefined
      ? NONE
      : unmapped('The semantic result has an unexpected shape.');
  }
  const partial =
    !semantic.data.chunkContentIncludedInContext ||
    (call.modelText?.includes(PROJECTION_OMITTED_CONTEXT_CHARS) ?? false);
  return {
    spans: semantic.data.chunks.flatMap((chunk): ContextSpan[] => {
      if (!chunk.filePath) {
        return [];
      }
      const { lineRange, metadata } = chunk;
      return [
        {
          chunkId: chunk.id,
          kind: 'semantic',
          path: chunk.filePath,
          ...(lineRange ? { endLine: lineRange.end, startLine: lineRange.start } : {}),
          ...(metadata?.rootId ? { rootId: metadata.rootId } : {}),
          ...(metadata?.rootName ? { rootName: metadata.rootName } : {}),
          ...(partial ? { partial: true } : {}),
        },
      ];
    }),
  };
}

function extractHybrid(call: MutableCall): Extracted {
  const hybrid = HybridDeliverySchema.safeParse(call.output);
  if (!hybrid.success) {
    return record(call.output)?.['results'] === undefined
      ? NONE
      : unmapped('The hybrid result has an unexpected shape.');
  }
  const shown =
    call.modelText === undefined ? undefined : parseProjectionShownCount(call.modelText);
  if (call.modelText !== undefined && shown === undefined) {
    return unmapped('The delivered hybrid header is unreadable.');
  }
  // Each hit reaches the model as a clipped excerpt of its chunk.
  return {
    spans: hybrid.data.results.slice(0, shown).flatMap((item): ContextSpan[] =>
      item.filePath
        ? [
            {
              chunkId: item.id,
              kind: 'semantic',
              partial: true,
              path: item.filePath,
              ...(item.rootName ? { rootName: item.rootName } : {}),
            },
          ]
        : []
    ),
  };
}

function extractStringReplace(call: MutableCall): Extracted {
  const edit = StringReplaceDeliverySchema.safeParse(call.output);
  if (!edit.success) {
    return unmapped('The edit result has an unexpected shape.');
  }
  const { editedLines, path, rootId } = edit.data;
  return {
    spans: [
      {
        kind: 'edit',
        path,
        rootId,
        ...(editedLines ? { endLine: editedLines.endLine, startLine: editedLines.startLine } : {}),
      },
    ],
  };
}

function extractWrite(call: MutableCall): Extracted {
  const write = WriteDeliverySchema.safeParse(call.output);
  if (!write.success) {
    return unmapped('The write result has an unexpected shape.');
  }
  return {
    spans: [{ kind: 'edit', path: write.data.path, rootId: write.data.rootId, wholeFile: true }],
  };
}

/** Content-bearing tools; every other tool delivers no file lines. */
const EXTRACTORS: Readonly<Record<string, (call: MutableCall) => Extracted>> = {
  'brainstrike.grepSearch': extractGrep,
  'brainstrike.hybridSearch': extractHybrid,
  'brainstrike.queryEmbeddingSpace': extractSemantic,
  'brainstrike.readWorkspaceFile': extractRead,
  'brainstrike.stringReplaceWorkspaceFile': extractStringReplace,
  'brainstrike.writeWorkspaceFile': extractWrite,
};

/** The spans a settled result delivered, or why it has none. */
function extractSpans(call: MutableCall): Extracted {
  return EXTRACTORS[call.toolName]?.(call) ?? NONE;
}

function modelOutputText(output: unknown): string | undefined {
  const value = record(output);
  if (value?.['type'] === 'text' || value?.['type'] === 'error-text') {
    return string(value['value']);
  }
  return;
}

/**
 * Folds one thread's committed rows into its context snapshot. Rows arrive
 * append-only; each is folded once, in commit order.
 */
export class ThreadContextFold {
  private readonly calls = new Map<string, MutableCall>();
  private readonly runs = new Map<string, MutableRun>();
  private lastSeq = Number.NEGATIVE_INFINITY;
  private snapshot: ThreadContextSnapshot | undefined;

  accept(rows: readonly CommittedAssistantLogRow[]): ThreadContextSnapshot {
    let changed = false;
    for (const row of rows) {
      if (row.seq <= this.lastSeq) {
        continue;
      }
      this.lastSeq = row.seq;
      changed = this.fold(row.event) || changed;
    }
    if (changed || !this.snapshot) {
      this.snapshot = this.read();
    }
    return this.snapshot;
  }

  private call(runId: string, toolCallId: string, toolName: string): MutableCall {
    let call = this.calls.get(toolCallId);
    if (!call) {
      call = { attachment: false, runId, status: 'pending', toolCallId, toolName };
      this.calls.set(toolCallId, call);
    }
    return call;
  }

  private settle(call: MutableCall, output: unknown): void {
    call.output = output;
    call.status = 'done';
    call.spans = undefined;
    call.frozen = undefined;
  }

  private fold(event: Readonly<Record<string, unknown>>): boolean {
    const runId = string(event['runId']);
    if (!runId) {
      return false;
    }
    switch (event['type']) {
      case 'run.started':
        return this.started(runId, event);
      case 'effect.started':
        return this.effectStarted(runId, event);
      case 'effect.finished':
        return this.effectFinished(event);
      case 'stream.chunk':
        return this.chunk(runId, record(event['chunk']));
      case 'model.step':
        return this.step(event['messages']);
      case 'provider.request.prepared':
        return this.prepared(runId, event);
      case 'context.compacted':
        return this.compacted(runId, event['compactedRunIds']);
      case 'references.unavailable':
        return this.failedPins(runId, event['files']);
      default:
        return false;
    }
  }

  private effectStarted(runId: string, event: Readonly<Record<string, unknown>>): boolean {
    const toolCallId = string(event['toolCallId']);
    if (!toolCallId) {
      return false;
    }
    const name =
      string(event['toolCatalogId']) ??
      denormalizeNativeToolName(string(event['toolId']) ?? 'unknown');
    const call = this.call(runId, toolCallId, name);
    call.toolName = name;
    call.frozen = undefined;
    return true;
  }

  private effectFinished(event: Readonly<Record<string, unknown>>): boolean {
    const call = this.calls.get(string(event['toolCallId']) ?? '');
    if (!call) {
      return false;
    }
    this.settle(call, event['output']);
    return true;
  }

  private compacted(runId: string, compactedRunIds: unknown): boolean {
    const run = this.runs.get(runId);
    if (!(run && Array.isArray(compactedRunIds))) {
      return false;
    }
    run.compactedRunIds.push(
      ...compactedRunIds.filter((id): id is string => typeof id === 'string')
    );
    run.frozen = undefined;
    return true;
  }

  private started(runId: string, event: Readonly<Record<string, unknown>>): boolean {
    const prompt = typeof event['prompt'] === 'string' ? event['prompt'] : '';
    const run: MutableRun = {
      compactedRunIds: [],
      measured: true,
      pinIds: [],
      prompt,
      requests: 0,
      runId,
      window: null,
    };
    for (const [index, mention] of parseFileMentionDirectives(prompt).entries()) {
      const toolCallId = `@file:${runId}:${index}`;
      run.pinIds.push(toolCallId);
      this.calls.set(toolCallId, {
        attachment: true,
        runId,
        spans: [{ kind: 'pinned', path: mention.path, rootId: mention.rootId, wholeFile: true }],
        status: 'done',
        toolCallId,
        toolName: '@file',
      });
    }
    this.runs.set(runId, run);
    return true;
  }

  private failedPins(runId: string, files: unknown): boolean {
    const run = this.runs.get(runId);
    const failures = ReferencedFileFailureSchema.array().safeParse(files);
    if (!(run && failures.success)) {
      return false;
    }
    for (const id of run.pinIds) {
      const pin = this.calls.get(id);
      const span = pin?.spans?.[0];
      if (
        pin &&
        span &&
        failures.data.some((file) => file.path === span.path && file.rootId === span.rootId)
      ) {
        pin.status = 'failed';
        pin.spans = [];
        pin.frozen = undefined;
      }
    }
    return true;
  }

  private chunk(runId: string, chunk: Readonly<Record<string, unknown>> | undefined): boolean {
    const toolCallId = string(chunk?.['toolCallId']);
    if (!(chunk && toolCallId)) {
      return false;
    }
    const type = chunk['type'];
    if (type === 'tool-call') {
      const known = this.calls.has(toolCallId);
      this.call(
        runId,
        toolCallId,
        denormalizeNativeToolName(string(chunk['toolName']) ?? 'unknown')
      );
      return !known;
    }
    if (type === 'tool-result') {
      const call = this.calls.get(toolCallId);
      if (!call || call.output !== undefined) {
        return false;
      }
      this.settle(call, chunk['output']);
      return true;
    }
    if (type === 'tool-error') {
      const call = this.calls.get(toolCallId);
      if (!call) {
        return false;
      }
      call.status = 'failed';
      call.spans = [];
      call.frozen = undefined;
      return true;
    }
    return false;
  }

  /** The model's text for each result, as its step committed it (the first wins). */
  private step(messages: unknown): boolean {
    if (!Array.isArray(messages)) {
      return false;
    }
    let changed = false;
    for (const message of messages) {
      const content = record(message)?.['content'];
      if (!Array.isArray(content)) {
        continue;
      }
      for (const part of content) {
        const value = record(part);
        const call = this.calls.get(string(value?.['toolCallId']) ?? '');
        if (value?.['type'] !== 'tool-result' || !call || call.modelText !== undefined) {
          continue;
        }
        const text = modelOutputText(value['output']);
        if (text !== undefined) {
          call.modelText = text;
          call.spans = undefined;
          call.frozen = undefined;
          changed = true;
        }
      }
    }
    return changed;
  }

  private prepared(runId: string, event: Readonly<Record<string, unknown>>): boolean {
    const run = this.runs.get(runId);
    if (!run) {
      return false;
    }
    run.requests += 1;
    run.frozen = undefined;
    const window = record(event['toolCallWindow']);
    if (!window) {
      // A receipt from before windows were recorded: this run's window is unknown.
      run.measured = false;
      return true;
    }
    // A new map per request: a snapshot may share it without copying.
    run.window = applyPromptToolCallWindow(
      run.window ?? undefined,
      window as unknown as PromptToolCallWindow
    );
    return true;
  }

  private read(): ThreadContextSnapshot {
    const calls = new Map<string, ContextCall>();
    for (const call of this.calls.values()) {
      if (call.spans === undefined && call.status === 'done') {
        const extracted = extractSpans(call);
        call.spans = extracted.spans;
        call.unmapped = extracted.unmapped;
      }
      call.frozen ??= {
        attachment: call.attachment,
        runId: call.runId,
        spans: call.spans ?? [],
        status: call.status,
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        ...(call.unmapped ? { unmapped: call.unmapped } : {}),
      };
      calls.set(call.toolCallId, call.frozen);
    }
    const runs = new Map<string, ContextRun>();
    for (const run of this.runs.values()) {
      run.frozen ??= {
        compactedRunIds: [...run.compactedRunIds],
        measured: run.measured,
        prompt: run.prompt,
        requests: run.requests,
        runId: run.runId,
        window: run.window,
      };
      runs.set(run.runId, run.frozen);
    }
    return { calls, runs };
  }
}

// --- Views -------------------------------------------------------------------

/**
 * The runs on the displayed branch, root first: the projection's head and its
 * ancestors. Host conversations name each assistant message by its run id.
 */
export function displayedBranchRunIds(
  repository: ExportedMessageRepository,
  runs: ReadonlyMap<string, unknown>
): string[] {
  const parents = new Map(repository.messages.map((item) => [item.message.id, item.parentId]));
  const branch: string[] = [];
  let id: string | null | undefined = repository.headId;
  const seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id);
    if (runs.has(id)) {
      branch.push(id);
    }
    id = parents.get(id);
  }
  return branch.reverse();
}

export type ContextCallState = 'collapsed' | 'compacted' | 'dropped' | 'in-window' | 'unknown';

export interface ContextCallAtTurn {
  readonly call: ContextCall;
  /**
   * Tokens of the call's input and result the first time a request carried its
   * full result; null when no committed window measured it.
   */
  readonly deliveredTokens: number | null;
  readonly state: ContextCallState;
  /** 1-based position of the call's run on the branch. */
  readonly turn: number;
  /** Tokens the call takes in the selected turn's window: its marker when collapsed, 0 when gone. */
  readonly windowTokens: number | null;
}

export interface ThreadContextAtTurn {
  readonly branch: readonly ContextRun[];
  readonly calls: readonly ContextCallAtTurn[];
  /** The selected turn (1-based); 0 when the branch has no runs. */
  readonly turn: number;
}

function callTokens(call: PromptToolCall): number {
  return call.inputTokens + call.outputTokens;
}

/** The first full appearance of each call across the given runs' windows. */
function firstDeliveredTokens(runs: readonly ContextRun[]): Map<string, number> {
  const delivered = new Map<string, number>();
  for (const run of runs) {
    for (const entry of run.window?.values() ?? []) {
      if (entry.output !== 'marker' && !delivered.has(entry.toolCallId)) {
        delivered.set(entry.toolCallId, callTokens(entry));
      }
    }
  }
  return delivered;
}

/** An attachment is in the window for its own run only; its tokens sit in the system text. */
function attachmentAt(call: ContextCall, callTurn: number, selected: number): ContextCallAtTurn {
  const own = callTurn === selected;
  return {
    call,
    deliveredTokens: null,
    state: own ? 'in-window' : 'dropped',
    turn: callTurn,
    windowTokens: own ? null : 0,
  };
}

/** A tool call's state from the selected turn's window: the host's record, never re-derived. */
function toolCallState(
  call: ContextCall,
  window: ReadonlyMap<string, PromptToolCall> | null,
  compacted: ReadonlySet<string>
): { readonly state: ContextCallState; readonly windowTokens: number | null } {
  if (window === null) {
    return { state: 'unknown', windowTokens: null };
  }
  const entry = window.get(call.toolCallId);
  if (entry) {
    return {
      state: entry.output === 'marker' ? 'collapsed' : 'in-window',
      windowTokens: callTokens(entry),
    };
  }
  return { state: compacted.has(call.runId) ? 'compacted' : 'dropped', windowTokens: 0 };
}

/**
 * Every call on the branch up to `turn` (default: the latest), with its state
 * and tokens as of that turn's last committed request.
 */
export function threadContextAt(
  snapshot: ThreadContextSnapshot,
  branchRunIds: readonly string[],
  turn: number = branchRunIds.length
): ThreadContextAtTurn {
  const branch = branchRunIds.flatMap((id) => {
    const run = snapshot.runs.get(id);
    return run ? [run] : [];
  });
  const selected = Math.max(0, Math.min(turn, branch.length));
  const upTo = branch.slice(0, selected);
  const position = new Map(upTo.map((run, index) => [run.runId, index + 1]));
  const current = upTo.at(-1);
  // A turn whose requests did not all record windows has an unknown window.
  const window = current?.measured ? current.window : null;
  const compacted = new Set(upTo.flatMap((run) => run.compactedRunIds));
  const delivered = firstDeliveredTokens(upTo);
  const calls: ContextCallAtTurn[] = [];
  for (const call of snapshot.calls.values()) {
    const callTurn = position.get(call.runId);
    if (callTurn === undefined) {
      continue;
    }
    if (call.attachment) {
      calls.push(attachmentAt(call, callTurn, selected));
      continue;
    }
    calls.push({
      call,
      deliveredTokens: delivered.get(call.toolCallId) ?? null,
      turn: callTurn,
      ...toolCallState(call, window ?? null, compacted),
    });
  }
  return { branch, calls, turn: selected };
}
