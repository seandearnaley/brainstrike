/**
 * Post-edit LSP diagnostics (report R2 Phase A).
 *
 * After a successful workspace edit, run a language server over the edited
 * file and surface its diagnostics (errors/warnings) in the tool result, so
 * the agent learns about a broken edit immediately instead of only when a
 * later build/test fails. Phase A ships the flagship TypeScript/JavaScript
 * server, BUNDLED as a desktop dependency so it works out-of-box; other
 * languages (Python/Go/Rust) come in Phase B via PATH discovery + a config
 * surface.
 *
 * Bespoke by design: core 1.51 ships an LSP primitive, but only inside its
 * (non-adopted) Workspace/sandbox model and behind unexported deep paths, so
 * we lift the WIRE PROTOCOL (standard vscode-jsonrpc + LSP), not the class.
 *
 * Servers are Node child processes spawned in Electron MAIN (the renderer-only
 * rule covers inference, not tooling — mirrors executeCommand's spawner). The
 * pool is keyed by workspace `rootId`; every server MUST be torn down on root
 * switch, factory reset, and app quit — see disposeLspServers /
 * evictLspServersForRoot and their wiring in main.ts + file-system-ipc.
 *
 * NO SILENT FALLBACKS: an unresolvable server, an unsupported language, or a
 * diagnostics timeout all resolve to an honest non-fatal result — never a
 * thrown error that would fail the underlying (already-successful) edit.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLogger } from '@brainstrike/utils/logger';
import {
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node';
import type {
  DefinitionParams,
  DidChangeTextDocumentParams,
  DidOpenTextDocumentParams,
  HoverParams,
  ImplementationParams,
  InitializeParams,
  InitializeResult,
  Position,
  PublishDiagnosticsParams,
} from 'vscode-languageserver-protocol/node';

// LSP method names used verbatim (string overloads avoid the branded-type
// identity mismatch between vscode-jsonrpc and -protocol under the main
// process's classic module resolution; the wire contract is the same).
const LSP = {
  definition: 'textDocument/definition',
  didChange: 'textDocument/didChange',
  didOpen: 'textDocument/didOpen',
  exit: 'exit',
  hover: 'textDocument/hover',
  implementation: 'textDocument/implementation',
  initialize: 'initialize',
  initialized: 'initialized',
  publishDiagnostics: 'textDocument/publishDiagnostics',
  shutdown: 'shutdown',
} as const;

const logger = createLogger('AssistantLspDiagnostics');

/** Timeout for the LSP server initialize handshake. */
const INIT_TIMEOUT_MS = 15_000;
/** Overall budget for diagnostics to arrive after opening/updating a file. */
const DIAGNOSTIC_TIMEOUT_MS = 6000;
/** Per-request budget for a hover/definition/implementation query (Phase B). */
const QUERY_TIMEOUT_MS = 4000;
/** Servers publish `[]` first while still analysing, then the real set — so an
 * empty result is not trusted immediately: poll this much longer for a
 * non-empty publish before returning empty (mirrors core's settle window). */
const DIAGNOSTIC_SETTLE_MS = 700;
/** Self-bound so a diagnostics blob can never tip the edit result over the
 * native tool-output budget: `lsp.diagnostics` is NESTED and not a trimmable
 * collection key, so the transport guard cannot rescue it — it must stay well
 * under the ~2750-token budget on its own. 15×300 ≈ 5.7KB worst case. */
const MAX_DIAGNOSTICS = 15;
const MAX_DIAGNOSTIC_MESSAGE_CHARS = 300;

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

/** A resolved language-server launch spec. */
interface ResolvedServer {
  /** Extra launch args after the CLI path. */
  args: string[];
  /** Absolute path to the server CLI entry (run via Electron-as-Node). */
  cliPath: string;
  /** initializationOptions sent during the handshake (e.g. bundled tsserver). */
  initializationOptions: Record<string, unknown>;
}

/** Extension → LSP languageId for the Phase A TypeScript/JavaScript server. */
const TS_LANGUAGE_BY_EXT: Record<string, string> = {
  '.cjs': 'javascript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascriptreact',
  '.mjs': 'javascript',
  '.mts': 'typescript',
  '.ts': 'typescript',
  '.tsx': 'typescriptreact',
};

export function languageIdForPath(absolutePath: string): string | undefined {
  return TS_LANGUAGE_BY_EXT[path.extname(absolutePath).toLowerCase()];
}

/**
 * Resolve the bundled typescript-language-server + typescript. Cached after the
 * first call. Returns null (never throws) when the deps cannot be resolved, so
 * a broken install degrades to an honest note.
 */
let cachedServer: ResolvedServer | null | undefined;
function resolveTypescriptServer(): ResolvedServer | null {
  if (cachedServer !== undefined) {
    return cachedServer;
  }
  try {
    const cliPath = require.resolve('typescript-language-server/lib/cli.mjs');
    // `require.resolve('typescript')` → typescript/lib/typescript.js; tsserver
    // lives beside it. Pinning it makes analysis deterministic (OUR bundled TS,
    // not whatever the user's project resolves) and is what makes diagnostics
    // fire reliably (verified).
    const tsserverPath = path.join(path.dirname(require.resolve('typescript')), 'tsserver.js');
    cachedServer = {
      args: ['--stdio'],
      cliPath,
      initializationOptions: { tsserver: { path: tsserverPath } },
    };
  } catch (error) {
    logger.error('typescript-language-server could not be resolved; LSP diagnostics disabled', {
      error,
    });
    cachedServer = null;
  }
  return cachedServer;
}

/** file:// URI or fs path → canonical comparison key for the diagnostics map.
 * fileURLToPath (not URL.pathname) so Windows drive letters round-trip
 * ("file:///C:/x" → "C:\x", not "/C:/x" — URL.pathname would never match the
 * absolute-path key written at diagnose() time, reporting every edit as a
 * timeout on Windows). A malformed URI from the server falls back to the raw
 * string: this runs inside the publishDiagnostics notification handler, where
 * a throw would kill the connection over one rogue publish. */
function diagnosticsKey(uriOrPath: string): string {
  let asPath = uriOrPath;
  if (uriOrPath.startsWith('file://')) {
    try {
      asPath = fileURLToPath(uriOrPath);
    } catch {
      /* not a valid file URI — key on the raw string */
    }
  }
  return process.platform === 'win32' ? asPath.toLowerCase() : asPath;
}

const SEVERITY_BY_CODE: Record<number, LspDiagnosticSeverity> = {
  1: 'error',
  2: 'warning',
  3: 'info',
  4: 'hint',
};
const SEVERITY_RANK: Record<LspDiagnosticSeverity, number> = {
  error: 0,
  hint: 3,
  info: 2,
  warning: 1,
};

interface RawDiagnostic {
  message?: unknown;
  range?: { start?: { line?: number; character?: number } };
  severity?: number;
  source?: unknown;
}

/** Raw LSP hover response (contents in any of the allowed shapes). */
interface RawHover {
  contents?: unknown;
}
/** Raw LSP Location or LocationLink (definition/implementation result). */
interface RawLocation {
  range?: { start?: { line?: number; character?: number } };
  targetRange?: { start?: { line?: number; character?: number } };
  targetSelectionRange?: { start?: { line?: number; character?: number } };
  targetUri?: string;
  uri?: string;
}

/**
 * Race `promise` against a `ms` deadline, resolving to `fallback` on timeout.
 * The timer is ALWAYS cleared once the race settles — on the common path where
 * `promise` wins, an uncleared timer would otherwise stay scheduled up to `ms`
 * (4s here, ×N queries per inspect), holding the event loop open and delaying
 * shutdown / test teardown.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<T>((resolve) => {
    handle = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise, timer]).finally(() => {
    if (handle) {
      clearTimeout(handle);
    }
  });
}

/** Flatten an LSP hover response (MarkupContent | MarkedString | array) to text. */
function extractHoverText(hover: RawHover): string | undefined {
  const { contents } = hover;
  const flatten = (value: unknown): string => {
    if (typeof value === 'string') {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map(flatten).filter(Boolean).join('\n');
    }
    if (value && typeof value === 'object' && 'value' in value) {
      const inner = (value as { value?: unknown }).value;
      return typeof inner === 'string' ? inner : '';
    }
    return '';
  };
  const text = flatten(contents).trim();
  return text.length > 0 ? text : undefined;
}

/** Normalize a definition/implementation result (Location | Location[] |
 * LocationLink[] | null) to a flat list of raw locations. */
function normalizeLocations(result: unknown): RawLocation[] {
  if (!result) {
    return [];
  }
  const list = Array.isArray(result) ? result : [result];
  return list.filter((entry): entry is RawLocation => Boolean(entry) && typeof entry === 'object');
}

/** Map raw LSP diagnostics to the bounded, model-facing shape. */
function boundDiagnostics(raw: RawDiagnostic[]): {
  diagnostics: EditDiagnostic[];
  total: number;
  truncated: boolean;
} {
  const mapped = raw.map((entry): EditDiagnostic => {
    const message = typeof entry.message === 'string' ? entry.message : String(entry.message ?? '');
    const boundedMessage =
      message.length > MAX_DIAGNOSTIC_MESSAGE_CHARS
        ? `${message.slice(0, MAX_DIAGNOSTIC_MESSAGE_CHARS)}…`
        : message;
    return {
      character: (entry.range?.start?.character ?? 0) + 1,
      line: (entry.range?.start?.line ?? 0) + 1,
      message: boundedMessage,
      severity: SEVERITY_BY_CODE[entry.severity ?? 1] ?? 'error',
      ...(typeof entry.source === 'string' ? { source: entry.source } : {}),
    };
  });
  // Most-severe first, then by line, so a truncated list keeps the errors.
  mapped.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.line - b.line);
  return {
    diagnostics: mapped.slice(0, MAX_DIAGNOSTICS),
    total: mapped.length,
    truncated: mapped.length > MAX_DIAGNOSTICS,
  };
}

/**
 * A single language-server child process + its JSON-RPC connection. Owns the
 * per-uri diagnostics map fed by textDocument/publishDiagnostics notifications
 * and the document versions for didOpen vs didChange.
 */
class LspServerConnection {
  private readonly child: ChildProcess;
  private readonly connection: MessageConnection;
  private readonly diagnostics = new Map<string, RawDiagnostic[]>();
  private readonly versions = new Map<string, number>();
  private initialized: Promise<void> | undefined;
  private disposed = false;

  constructor(
    private readonly server: ResolvedServer,
    private readonly rootPath: string
  ) {
    this.child = spawn(process.execPath, [server.cliPath, ...server.args], {
      cwd: rootPath,
      // ELECTRON_RUN_AS_NODE lets the packaged app run the server's JS entry
      // through Electron's bundled Node (there is no standalone `node`).
      // biome-ignore lint/style/useNamingConvention: OS env var name is fixed
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Drain stderr so a chatty server can't fill the pipe buffer and stall.
    this.child.stderr?.on('data', () => {
      /* discarded — server logs are not tool output */
    });
    // Swallow pipe/process errors so killing the server mid-write (dispose,
    // crash) can never surface an unhandled EPIPE/ERR_STREAM_DESTROYED — the
    // diagnostics call already degrades to an honest note on any failure.
    this.child.on('error', () => {
      /* spawn/runtime failure — handled as a diagnostics timeout */
    });
    this.child.stdin?.on('error', () => {
      /* writing to a dead server's stdin (EPIPE); ignore */
    });
    this.child.stdout?.on('error', () => {
      /* reader stream torn down on dispose; ignore */
    });
    this.connection = createMessageConnection(
      new StreamMessageReader(this.child.stdout as NodeJS.ReadableStream),
      new StreamMessageWriter(this.child.stdin as NodeJS.WritableStream)
    );
    this.connection.onNotification(LSP.publishDiagnostics, (params: PublishDiagnosticsParams) => {
      this.diagnostics.set(diagnosticsKey(params.uri), params.diagnostics as RawDiagnostic[]);
    });
    this.connection.onError(() => {
      /* transport errors surface as a diagnostics timeout, not a throw */
    });
    this.connection.listen();
  }

  get pid(): number {
    return this.child.pid ?? -1;
  }

  /**
   * Fire-and-forget a notification, SWALLOWING its promise rejection. Writing
   * to a server killed mid-flight (dispose, crash) rejects with EPIPE; without
   * this the rejection is unhandled (CI-visible, timing-dependent). The
   * diagnostics/inspect calls already degrade to an honest note on failure.
   */
  private notify(method: string, params?: unknown): void {
    this.connection.sendNotification(method, params).catch(() => {
      /* server gone / pipe closed — handled as a timeout upstream */
    });
  }

  private ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      const rootUri = pathToFileURL(this.rootPath).href;
      const initializeParams: InitializeParams = {
        capabilities: {
          textDocument: {
            definition: { dynamicRegistration: false },
            hover: { contentFormat: ['markdown', 'plaintext'], dynamicRegistration: false },
            implementation: { dynamicRegistration: false },
            publishDiagnostics: { relatedInformation: false },
            synchronization: { didSave: false, dynamicRegistration: false },
          },
        },
        initializationOptions: this.server.initializationOptions,
        processId: process.pid,
        rootUri,
        workspaceFolders: [{ name: 'workspace', uri: rootUri }],
      };
      this.initialized = Promise.race([
        this.connection.sendRequest<InitializeResult>(LSP.initialize, initializeParams).then(() => {
          this.notify(LSP.initialized, {});
        }),
        new Promise<void>((_, reject) => {
          setTimeout(() => reject(new Error('LSP initialize timed out')), INIT_TIMEOUT_MS);
        }),
      ]);
    }
    return this.initialized;
  }

  /** Open (or re-sync) a document with the given content, bumping its version.
   * Returns the file URI. Clears the prior publish so a subsequent
   * waitForDiagnostics observes THIS content's result. */
  private syncDocument(absolutePath: string, content: string, languageId: string): string {
    const uri = pathToFileURL(absolutePath).href;
    const key = diagnosticsKey(absolutePath);
    this.diagnostics.delete(key);
    const previousVersion = this.versions.get(key);
    if (previousVersion === undefined) {
      this.versions.set(key, 1);
      const openParams: DidOpenTextDocumentParams = {
        textDocument: { languageId, text: content, uri, version: 1 },
      };
      this.notify(LSP.didOpen, openParams);
    } else {
      const nextVersion = previousVersion + 1;
      this.versions.set(key, nextVersion);
      const changeParams: DidChangeTextDocumentParams = {
        contentChanges: [{ text: content }],
        textDocument: { uri, version: nextVersion },
      };
      this.notify(LSP.didChange, changeParams);
    }
    return uri;
  }

  /** Open (or re-sync) a document and wait for its diagnostics to settle. */
  async diagnose(
    absolutePath: string,
    content: string,
    languageId: string
  ): Promise<RawDiagnostic[]> {
    await this.ensureInitialized();
    this.syncDocument(absolutePath, content, languageId);
    return this.waitForDiagnostics(diagnosticsKey(absolutePath));
  }

  /**
   * Semantic inspection at a position (report R2 Phase B): open the file, let
   * the server index (settle-window), then query hover + definition +
   * implementation in parallel and pull the line-scoped diagnostics. Each query
   * is independently bounded and degrades to undefined on timeout/absence —
   * never throws.
   */
  async inspect(
    absolutePath: string,
    content: string,
    languageId: string,
    position: Position
  ): Promise<{
    hover?: string;
    diagnostics: RawDiagnostic[];
    definition: RawLocation[];
    implementation: RawLocation[];
  }> {
    await this.ensureInitialized();
    const uri = this.syncDocument(absolutePath, content, languageId);
    // Let the server analyse the freshly-opened document before querying
    // (the same settle rationale as diagnostics — queries on an un-indexed
    // file return empty).
    const lineDiagnostics = await this.waitForDiagnostics(diagnosticsKey(absolutePath));
    const [hover, definition, implementation] = await Promise.all([
      this.queryHover(uri, position),
      this.queryLocations(LSP.definition, uri, position),
      this.queryLocations(LSP.implementation, uri, position),
    ]);
    return {
      definition,
      diagnostics: lineDiagnostics.filter(
        (entry) => (entry.range?.start?.line ?? -1) === position.line
      ),
      implementation,
      ...(hover ? { hover } : {}),
    };
  }

  private async queryHover(uri: string, position: Position): Promise<string | undefined> {
    try {
      const params: HoverParams = { position, textDocument: { uri } };
      const result = await withTimeout<RawHover | null>(
        this.connection.sendRequest<RawHover | null>(LSP.hover, params),
        QUERY_TIMEOUT_MS,
        null
      );
      return result ? extractHoverText(result) : undefined;
    } catch {
      return;
    }
  }

  private async queryLocations(
    method: string,
    uri: string,
    position: Position
  ): Promise<RawLocation[]> {
    try {
      const params: DefinitionParams | ImplementationParams = {
        position,
        textDocument: { uri },
      };
      const result = await withTimeout<unknown>(
        this.connection.sendRequest<unknown>(method, params),
        QUERY_TIMEOUT_MS,
        null
      );
      return normalizeLocations(result);
    } catch {
      return [];
    }
  }

  private async waitForDiagnostics(key: string): Promise<RawDiagnostic[]> {
    const deadline = Date.now() + DIAGNOSTIC_TIMEOUT_MS;
    let firstEmptyAt: number | undefined;
    while (Date.now() < deadline && !this.disposed) {
      const current = this.diagnostics.get(key);
      if (current !== undefined) {
        if (current.length > 0) {
          return current;
        }
        // Empty publish: give the server a settle window to upgrade it to a
        // real result before trusting the "clean" verdict.
        if (firstEmptyAt === undefined) {
          firstEmptyAt = Date.now();
        } else if (Date.now() - firstEmptyAt >= DIAGNOSTIC_SETTLE_MS) {
          return [];
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    // Timed out before any publish (or while settling) — return whatever we
    // have; the caller distinguishes "no publish at all" via the map miss.
    return this.diagnostics.get(key) ?? [];
  }

  /** Whether any publish (even empty) was seen for this document. */
  hasPublishedFor(absolutePath: string): boolean {
    return this.diagnostics.has(diagnosticsKey(absolutePath));
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    // Only attempt a graceful LSP shutdown while the process is still alive;
    // writing shutdown/exit to an already-exited server just races an EPIPE
    // that the SIGKILL below settles anyway.
    if (this.child.exitCode === null && this.child.signalCode === null) {
      try {
        await Promise.race([
          this.connection.sendRequest(LSP.shutdown).then(() => {
            this.notify(LSP.exit);
          }),
          new Promise((resolve) => setTimeout(resolve, 500)),
        ]);
      } catch {
        /* best effort — we SIGKILL below regardless */
      }
    }
    try {
      this.connection.dispose();
    } catch {
      /* connection already down */
    }
    // SIGKILL is the authoritative teardown (no orphaned server process).
    this.child.kill('SIGKILL');
  }
}

/** rootId → its pooled server connection, stored as a PROMISE registered
 * synchronously at first touch — see acquireLspServer. */
const pool = new Map<string, Promise<LspServerConnection>>();

/**
 * Get-or-create the pooled server for a root. Creation is serialized per
 * rootId by registering the pool entry in the SAME synchronous frame as the
 * miss check: the diagnose locks are per-FILE, so two concurrent first-touches
 * of different files under one root race this path — a bare get → create →
 * set would let each spawn a server child and orphan one (never disposed).
 * Storing the promise keeps that invariant structural even if construction
 * ever grows an await (e.g. Phase B async PATH discovery).
 */
function acquireLspServer(
  rootId: string,
  rootPath: string,
  server: ResolvedServer
): Promise<LspServerConnection> {
  const existing = pool.get(rootId);
  if (existing) {
    return existing;
  }
  const created = Promise.resolve().then(() => new LspServerConnection(server, rootPath));
  pool.set(rootId, created);
  // A failed creation must not poison the root forever: evict the entry so the
  // next edit retries. The rejection itself still surfaces to every caller
  // awaiting this promise (honest degrade in getEditDiagnostics's catch).
  created.catch(() => {
    if (pool.get(rootId) === created) {
      pool.delete(rootId);
    }
  });
  return created;
}

/**
 * Per-file diagnose serialization. A pooled server's diagnostics map + document
 * versions are keyed by path and shared across callers, so two concurrent edits
 * to the SAME file (Mastra runs tool calls within a step concurrently) racing
 * open/change → wait could cross-attribute one edit's diagnostics to the other.
 * This lock serializes ONLY the diagnose step, keyed by canonical absolute path
 * — deliberately SEPARATE from the edit tools' write lock so a slow
 * language-server round-trip never adds latency back onto the write path.
 */
const diagnoseLocks = new Map<string, Promise<unknown>>();

function withDiagnoseLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = diagnoseLocks.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  const chain = run.then(
    () => undefined,
    () => undefined
  );
  diagnoseLocks.set(key, chain);
  void chain.finally(() => {
    if (diagnoseLocks.get(key) === chain) {
      diagnoseLocks.delete(key);
    }
  });
  return run;
}

export interface GetEditDiagnosticsArgs {
  absolutePath: string;
  content: string;
  /** Test seam: override server resolution (return null to simulate missing). */
  resolveServerForTest?: () => ResolvedServer | null;
  rootId: string;
  rootPath: string;
}

/**
 * Diagnose a just-edited file. Never throws: an unsupported language, an
 * unresolvable server, or a timeout all resolve to an honest result the caller
 * attaches to the (already-successful) edit result.
 */
export async function getEditDiagnostics(
  args: GetEditDiagnosticsArgs
): Promise<EditDiagnosticsResult> {
  const language = languageIdForPath(args.absolutePath);
  if (!language) {
    return { available: false, reason: 'unsupported-language' };
  }
  const resolveServer = args.resolveServerForTest ?? resolveTypescriptServer;
  const server = resolveServer();
  if (!server) {
    return {
      available: false,
      language,
      message:
        'The TypeScript/JavaScript language server is unavailable, so diagnostics were skipped for this edit.',
      reason: 'server-unavailable',
    };
  }

  try {
    // Serialize per file so concurrent same-file edits can't cross-attribute
    // each other's diagnostics through the shared per-connection state.
    return await withDiagnoseLock(diagnosticsKey(args.absolutePath), async () => {
      const connection = await acquireLspServer(args.rootId, args.rootPath, server);
      const raw = await connection.diagnose(args.absolutePath, args.content, language);
      if (!connection.hasPublishedFor(args.absolutePath)) {
        // No publish arrived within the budget — honest timeout note.
        return {
          available: false,
          language,
          message: `Diagnostics timed out after ${DIAGNOSTIC_TIMEOUT_MS}ms; the edit still applied.`,
          reason: 'timeout',
        };
      }
      const bounded = boundDiagnostics(raw);
      return {
        available: true,
        diagnosticCount: bounded.total,
        diagnostics: bounded.diagnostics,
        language,
        truncated: bounded.truncated,
      };
    });
  } catch (error) {
    logger.error('LSP diagnostics failed; edit still applied', { error });
    return {
      available: false,
      language,
      message: 'Diagnostics could not be collected for this edit.',
      reason: 'server-unavailable',
    };
  }
}

/** One definition/implementation location in model-facing shape. */
export interface InspectLocation {
  /** 1-based line of the target. */
  line: number;
  /** Workspace-relative path when under the root, else absolute. */
  path: string;
  /** Bounded one-line preview of the target line, when readable. */
  preview?: string;
}

/**
 * Result of an `lspInspect` call (report R2 Phase B). Mirrors core's tool
 * contract: hover / line diagnostics / definition / implementation groups.
 * `available:false` carries an honest reason exactly like the diagnostics path.
 */
export interface LspInspectionResult {
  available: boolean;
  definition?: InspectLocation[];
  diagnostics?: EditDiagnostic[];
  hover?: string;
  implementation?: InspectLocation[];
  language?: string;
  message?: string;
  reason?: LspUnavailableReason;
}

/** file:// URI → fs path. fileURLToPath (not URL.pathname) so Windows drive
 * letters round-trip ("file:///C:/x" → "C:\x", not "/C:/x"). A malformed
 * file URI from the server falls through to the raw URI, which stays visible
 * in the location's display path rather than failing the whole inspection. */
function uriToPath(uri: string): string {
  if (!uri.startsWith('file://')) {
    return uri;
  }
  try {
    return fileURLToPath(uri);
  } catch {
    return uri;
  }
}

const MAX_INSPECT_LOCATIONS = 10;
const MAX_HOVER_CHARS = 1200;
const MAX_PREVIEW_CHARS = 200;
/**
 * Ceiling on a definition/implementation TARGET file we'll read just to build a
 * one-line preview. tsserver routinely resolves into large generated `.d.ts`
 * files; reading a multi-MB target whole into Electron main for a 200-char
 * preview would memory-spike and bypasses the workspace reader's own size
 * guard. Over this, the preview is omitted (path + line are still returned).
 */
const MAX_PREVIEW_FILE_BYTES = 2 * 1024 * 1024;

/** Workspace-relative "/path" when under root, else the absolute path. */
function toDisplayPath(absolutePath: string, rootPath: string): string {
  const relative = path.relative(rootPath, absolutePath);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return `/${relative.split(path.sep).join('/')}`;
  }
  return absolutePath;
}

/**
 * Best-effort bounded preview of a 1-based line (undefined on read error or an
 * oversized target). Stats first so a huge generated `.d.ts` target can't be
 * slurped whole into memory for a 200-char preview — the preview is optional,
 * so skipping it degrades an accessory field, never the location itself.
 */
async function readLinePreview(absolutePath: string, line: number): Promise<string | undefined> {
  try {
    const stat = await fsPromises.stat(absolutePath);
    if (!stat.isFile() || stat.size > MAX_PREVIEW_FILE_BYTES) {
      return;
    }
    const fileText = await fsPromises.readFile(absolutePath, 'utf8');
    const target = fileText.split('\n')[line - 1]?.trim();
    if (!target) {
      return;
    }
    return target.length > MAX_PREVIEW_CHARS ? `${target.slice(0, MAX_PREVIEW_CHARS)}…` : target;
  } catch {
    return;
  }
}

async function toInspectLocations(
  raw: RawLocation[],
  rootPath: string
): Promise<InspectLocation[]> {
  const seen = new Set<string>();
  const locations: InspectLocation[] = [];
  for (const entry of raw.slice(0, MAX_INSPECT_LOCATIONS * 2)) {
    const uri = entry.uri ?? entry.targetUri;
    if (!uri) {
      continue;
    }
    const range = entry.range ?? entry.targetRange ?? entry.targetSelectionRange;
    const absolutePath = uriToPath(uri);
    const line = (range?.start?.line ?? 0) + 1;
    const dedupeKey = `${absolutePath}:${line}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    const preview = await readLinePreview(absolutePath, line);
    locations.push({
      line,
      path: toDisplayPath(absolutePath, rootPath),
      ...(preview ? { preview } : {}),
    });
    if (locations.length >= MAX_INSPECT_LOCATIONS) {
      break;
    }
  }
  return locations;
}

export interface GetLspInspectionArgs {
  absolutePath: string;
  content: string;
  /** 0-based cursor position (the tool converts the 1-based line + `<<<`). */
  position: Position;
  resolveServerForTest?: () => ResolvedServer | null;
  rootId: string;
  rootPath: string;
}

/**
 * Semantic inspection at a cursor (report R2 Phase B). Never throws: an
 * unsupported language, an unresolvable server, or query timeouts all resolve
 * to an honest result. Serialized per file (shared connection state).
 */
export async function getLspInspection(args: GetLspInspectionArgs): Promise<LspInspectionResult> {
  const language = languageIdForPath(args.absolutePath);
  if (!language) {
    return {
      available: false,
      message: `LSP inspection is not available for this file type (no ${path.extname(args.absolutePath) || 'unknown'} language server).`,
      reason: 'unsupported-language',
    };
  }
  const server = (args.resolveServerForTest ?? resolveTypescriptServer)();
  if (!server) {
    return {
      available: false,
      language,
      message: 'The TypeScript/JavaScript language server is unavailable.',
      reason: 'server-unavailable',
    };
  }

  try {
    return await withDiagnoseLock(diagnosticsKey(args.absolutePath), async () => {
      let connection = pool.get(args.rootId);
      if (!connection) {
        connection = new LspServerConnection(server, args.rootPath);
        pool.set(args.rootId, connection);
      }
      const raw = await connection.inspect(
        args.absolutePath,
        args.content,
        language,
        args.position
      );
      const hover =
        raw.hover && raw.hover.length > MAX_HOVER_CHARS
          ? `${raw.hover.slice(0, MAX_HOVER_CHARS)}…`
          : raw.hover;
      const [definition, implementation] = await Promise.all([
        toInspectLocations(raw.definition, args.rootPath),
        toInspectLocations(raw.implementation, args.rootPath),
      ]);
      const diagnostics = boundDiagnostics(raw.diagnostics).diagnostics;
      return {
        available: true,
        language,
        ...(hover ? { hover } : {}),
        ...(diagnostics.length > 0 ? { diagnostics } : {}),
        ...(definition.length > 0 ? { definition } : {}),
        ...(implementation.length > 0 ? { implementation } : {}),
      };
    });
  } catch (error) {
    logger.error('LSP inspection failed', { error });
    return {
      available: false,
      language,
      message: 'Inspection could not be collected.',
      reason: 'server-unavailable',
    };
  }
}

/** Number of pooled servers (test/observability). */
export function countPooledLspServers(): number {
  return pool.size;
}

/** Pooled server pids (test only — no-orphan proof). */
export async function __getPooledPidsForTest(): Promise<number[]> {
  const settled = await Promise.allSettled(pool.values());
  return settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value.pid] : []));
}

/**
 * Dispose every pooled language server (SIGKILL — no orphans). Wired into
 * main.ts factory-reset runtimes AND graceful shutdown, mirroring the shell
 * and terminal process reapers. Returns the count disposed. Awaits pending
 * creations first so a server mid-spawn cannot slip past teardown.
 */
export async function disposeLspServers(): Promise<number> {
  const pending = Array.from(pool.values());
  pool.clear();
  const settled = await Promise.allSettled(pending);
  const connections = settled.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : []
  );
  await Promise.allSettled(connections.map((connection) => connection.dispose()));
  return connections.length;
}

/** Dispose the server(s) for a single root (root removed/closed). */
export async function evictLspServersForRoot(rootId: string): Promise<void> {
  const pending = pool.get(rootId);
  if (!pending) {
    return;
  }
  pool.delete(rootId);
  const connection = await pending.catch(() => null);
  await connection?.dispose();
}
