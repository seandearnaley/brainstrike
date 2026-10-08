import type { AssistantTaskItem } from '@brainstrike/agent';
import type { HostWorkspaceEditTracker } from '@brainstrike/agent-host';

/**
 * The shell-supplied capabilities of the shared native tools. The agent host
 * passes Core's capabilities; Desktop's legacy assistant server passes its
 * PGlite-backed adapters for legacy threads. An absent optional port is the
 * capability result, reported in the tool output where the tool has one.
 */

/** The tool call an edit is attributed to. */
export interface NativeEditCall {
  /** A delegated child's own thread, when the call runs inside one. */
  readonly executionThreadId: string | undefined;
  readonly toolCallId: string | undefined;
  readonly toolName: string;
}

export type LspDiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint';

/** One diagnostic in model-facing shape (1-based line/character). */
export interface EditDiagnostic {
  character: number;
  line: number;
  message: string;
  severity: LspDiagnosticSeverity;
  source?: string;
}

/** Why diagnostics are unavailable (only set when `available` is false). */
export type LspUnavailableReason = 'unsupported-language' | 'server-unavailable' | 'timeout';

/**
 * Attached to an edit tool's result. Omitted entirely by the caller when the
 * language is unsupported (no note spam on every markdown/json edit); present
 * with `available:false` + `message` when a language we DO support has no
 * working server or timed out (honest, never silent).
 */
export interface EditDiagnosticsResult {
  available: boolean;
  /** Total diagnostics before self-bounding (>= diagnostics.length). */
  diagnosticCount?: number;
  diagnostics?: EditDiagnostic[];
  language?: string;
  message?: string;
  reason?: LspUnavailableReason;
  truncated?: boolean;
}

/** Workspace Index maintenance a shell runs inside the file lock after a mutation. */
export interface WorkspaceIndexMaintenance {
  deleted(args: {
    readonly rootId: string;
    readonly workspacePath: string;
  }): Promise<{ readonly invalidated: boolean }>;
  edited(args: {
    readonly absolutePath: string;
    readonly content: string;
    readonly rootId: string;
    readonly size: number;
    readonly workspacePath: string;
  }): Promise<void>;
  renamed(args: {
    readonly absolutePath: string;
    readonly rootId: string;
    readonly rootPath: string;
    readonly workspacePath: string;
  }): Promise<void>;
}

/** The file-mutation tools' ports. */
export interface FileMutationPorts {
  /** Post-edit language-server diagnostics; absent leaves the result without `lsp`. */
  readonly diagnostics?: (args: {
    readonly absolutePath: string;
    readonly content: string;
    readonly rootId: string;
    readonly rootPath: string;
  }) => Promise<EditDiagnosticsResult>;
  /** The one attribution owner for this execution's edits. */
  edits(call: NativeEditCall): HostWorkspaceEditTracker;
  /** Absent when the shell's index watches files itself; delete/rename then report no invalidation. */
  readonly index?: WorkspaceIndexMaintenance;
}

/** One thread's current plan. */
export interface TaskListStore {
  /** Atomically replace the plan from the latest persisted one; returns what was stored. */
  replace(
    next: (previous: readonly AssistantTaskItem[]) => AssistantTaskItem[]
  ): Promise<readonly AssistantTaskItem[]>;
}

export const CANVAS_CREATED_BY_VALUES = ['assistant', 'user'] as const;
export type CanvasCreatedBy = (typeof CANVAS_CREATED_BY_VALUES)[number];

/** One stored canvas version. */
export interface CanvasVersion {
  readonly canvasId: string;
  /** Full-precision timestamp text, never routed through a JS `Date` by stores that have one. */
  readonly createdAt: string;
  readonly createdBy: CanvasCreatedBy;
  readonly html: string;
  readonly title: string;
  readonly version: number;
}

export type CanvasRepositoryError =
  | 'ambiguous_match'
  | 'no_match'
  | 'not_found'
  | 'too_large'
  | 'version_conflict';
export interface CanvasRepositoryFailure {
  readonly error: CanvasRepositoryError;
  readonly ok: false;
}
export interface CanvasMutationSuccess {
  readonly canvasId: string;
  readonly version: number;
}
export type CanvasMutationResult = CanvasMutationSuccess | CanvasRepositoryFailure;

export interface CanvasSummary {
  readonly canvasId: string;
  readonly createdAt: string;
  readonly title: string;
  readonly version: number;
}

/** Newest-first cap on listings; exhaustion is reported, never silent. */
export const CANVAS_LIST_LIMIT = 50;

export interface CanvasListResult {
  readonly canvases: readonly CanvasSummary[];
  /** True when more canvases exist beyond {@link CANVAS_LIST_LIMIT}. */
  readonly truncated: boolean;
}

/** One thread's canvases. Every store enforces the HTML byte ceiling on what it stores. */
export interface CanvasStore {
  create(input: {
    readonly createdBy: CanvasCreatedBy;
    readonly html: string;
    readonly title: string;
  }): Promise<CanvasMutationResult>;
  list(): Promise<CanvasListResult>;
  /**
   * Store the next version of `canvasId` computed from its latest one. `next`
   * returns the new HTML or a failure; a concurrent writer of the same version
   * is `version_conflict`.
   */
  revise(
    canvasId: string,
    next: (latest: CanvasVersion) => string | CanvasRepositoryFailure
  ): Promise<CanvasMutationResult>;
}
