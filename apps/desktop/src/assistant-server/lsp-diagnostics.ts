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
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLogger } from '@brainstrike/utils/logger';
import {
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node';
import type {
  DidChangeTextDocumentParams,
  DidOpenTextDocumentParams,
  InitializeParams,
  InitializeResult,
  PublishDiagnosticsParams,
} from 'vscode-languageserver-protocol/node';

// LSP method names used verbatim (string overloads avoid the branded-type
// identity mismatch between vscode-jsonrpc and -protocol under the main
// process's classic module resolution; the wire contract is the same).
const LSP = {
  didChange: 'textDocument/didChange',
  didOpen: 'textDocument/didOpen',
  exit: 'exit',
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

/** file:// URI or fs path → canonical comparison key for the diagnostics map. */
function diagnosticsKey(uriOrPath: string): string {
  const asPath = uriOrPath.startsWith('file://')
    ? decodeURIComponent(new URL(uriOrPath).pathname)
    : uriOrPath;
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

  private ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      const rootUri = pathToFileURL(this.rootPath).href;
      const initializeParams: InitializeParams = {
        capabilities: {
          textDocument: {
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
          void this.connection.sendNotification(LSP.initialized, {});
        }),
        new Promise<void>((_, reject) => {
          setTimeout(() => reject(new Error('LSP initialize timed out')), INIT_TIMEOUT_MS);
        }),
      ]);
    }
    return this.initialized;
  }

  /** Open (or re-sync) a document and wait for its diagnostics to settle. */
  async diagnose(
    absolutePath: string,
    content: string,
    languageId: string
  ): Promise<RawDiagnostic[]> {
    await this.ensureInitialized();
    const uri = pathToFileURL(absolutePath).href;
    const key = diagnosticsKey(absolutePath);
    // Clear the prior publish so the settle loop waits for THIS edit's result.
    this.diagnostics.delete(key);
    const previousVersion = this.versions.get(key);
    if (previousVersion === undefined) {
      this.versions.set(key, 1);
      const openParams: DidOpenTextDocumentParams = {
        textDocument: { languageId, text: content, uri, version: 1 },
      };
      void this.connection.sendNotification(LSP.didOpen, openParams);
    } else {
      const nextVersion = previousVersion + 1;
      this.versions.set(key, nextVersion);
      const changeParams: DidChangeTextDocumentParams = {
        contentChanges: [{ text: content }],
        textDocument: { uri, version: nextVersion },
      };
      void this.connection.sendNotification(LSP.didChange, changeParams);
    }
    return this.waitForDiagnostics(key);
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
    try {
      await Promise.race([
        this.connection.sendRequest(LSP.shutdown).then(() => {
          void this.connection.sendNotification(LSP.exit);
        }),
        new Promise((resolve) => setTimeout(resolve, 500)),
      ]);
    } catch {
      /* best effort — we SIGKILL below regardless */
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

/** rootId → its pooled server connection. */
const pool = new Map<string, LspServerConnection>();

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
    let connection = pool.get(args.rootId);
    if (!connection) {
      connection = new LspServerConnection(server, args.rootPath);
      pool.set(args.rootId, connection);
    }
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

/** Number of pooled servers (test/observability). */
export function countPooledLspServers(): number {
  return pool.size;
}

/** Pooled server pids (test only — no-orphan proof). */
export function __getPooledPidsForTest(): number[] {
  return Array.from(pool.values(), (connection) => connection.pid);
}

/**
 * Dispose every pooled language server (SIGKILL — no orphans). Wired into
 * main.ts factory-reset runtimes AND graceful shutdown, mirroring the shell
 * and terminal process reapers. Returns the count disposed.
 */
export async function disposeLspServers(): Promise<number> {
  const connections = Array.from(pool.values());
  pool.clear();
  await Promise.allSettled(connections.map((connection) => connection.dispose()));
  return connections.length;
}

/** Dispose the server(s) for a single root (root removed/closed). */
export async function evictLspServersForRoot(rootId: string): Promise<void> {
  const connection = pool.get(rootId);
  if (!connection) {
    return;
  }
  pool.delete(rootId);
  await connection.dispose();
}
