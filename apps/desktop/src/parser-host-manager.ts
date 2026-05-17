/**
 * Parser host manager.
 *
 * Owns the lifecycle of an Electron `utilityProcess` running the
 * parser-host-entry module. Mirrors the lifecycle/correlation patterns of
 * `db-host-manager.ts` but is much simpler because parsing is stateless:
 * no transactions, no live queries, no draining. Each parse is a single
 * round-trip request/response.
 *
 * Public API: `parse(request)` returns the response. `stop()` kills the
 * host and rejects any in-flight requests.
 *
 * See: docs/prd-chunking-wasm-parser-2026-05.md §4
 */

import path from 'node:path';
import { type UtilityProcess, utilityProcess } from 'electron';
import type { ParserHostParseRequest, ParserHostParseResponse } from './parser-host-shared';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

interface PendingRequest {
  readonly resolve: (response: ParserHostParseResponse) => void;
  readonly timer: NodeJS.Timeout;
}

export interface ParserHostManagerOptions {
  /** Path to the parser-host-entry.js bundled output. Defaults to a sibling lookup. */
  readonly entryPath?: string;
  /** Per-request timeout in milliseconds. */
  readonly requestTimeoutMs?: number;
}

function resolveDefaultEntryPath(): string {
  // Mirror db-host-manager.resolveDefaultEntryPath. The main process build
  // is CommonJS, so module.filename is reliable; the cwd fallback only
  // matters in the (rare) case where the bundler stripped module info.
  const currentModuleFilename =
    typeof module.filename === 'string' && module.filename.length > 0
      ? module.filename
      : path.join(process.cwd(), 'parser-host-manager.js');
  return path.join(path.dirname(currentModuleFilename), 'parser-host-entry.js');
}

function isParserHostParseResponse(value: unknown): value is ParserHostParseResponse {
  return (
    value !== null &&
    typeof value === 'object' &&
    'requestId' in value &&
    typeof (value as { requestId?: unknown }).requestId === 'string' &&
    'ok' in value &&
    typeof (value as { ok?: unknown }).ok === 'boolean'
  );
}

export class ParserHostManager {
  readonly #entryPath: string;
  readonly #requestTimeoutMs: number;
  #host: UtilityProcess | null = null;
  readonly #pending = new Map<string, PendingRequest>();

  constructor(options: ParserHostManagerOptions = {}) {
    this.#entryPath = options.entryPath ?? resolveDefaultEntryPath();
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  parse(request: ParserHostParseRequest): Promise<ParserHostParseResponse> {
    const host = this.#ensureHost();
    return new Promise<ParserHostParseResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(request.requestId);
        resolve({
          error: `parser host timeout after ${this.#requestTimeoutMs}ms`,
          ok: false,
          requestId: request.requestId,
        });
      }, this.#requestTimeoutMs);
      this.#pending.set(request.requestId, { resolve, timer });
      host.postMessage(request);
    });
  }

  async stop(): Promise<void> {
    const host = this.#host;
    if (host) {
      host.kill();
      this.#host = null;
    }
    this.#rejectAllPending('parser host stopped');
    await Promise.resolve();
  }

  #ensureHost(): UtilityProcess {
    if (this.#host) {
      return this.#host;
    }
    const host = utilityProcess.fork(this.#entryPath);
    host.on('message', (message: unknown) => {
      this.#handleResponse(message);
    });
    host.on('exit', () => {
      this.#handleExit();
    });
    this.#host = host;
    return host;
  }

  #handleResponse(message: unknown): void {
    if (!isParserHostParseResponse(message)) {
      return;
    }
    const pending = this.#pending.get(message.requestId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.#pending.delete(message.requestId);
    pending.resolve(message);
  }

  #handleExit(): void {
    this.#host = null;
    this.#rejectAllPending('parser host exited unexpectedly');
  }

  #rejectAllPending(error: string): void {
    for (const [requestId, { resolve, timer }] of this.#pending) {
      clearTimeout(timer);
      resolve({ error, ok: false, requestId });
    }
    this.#pending.clear();
  }
}
