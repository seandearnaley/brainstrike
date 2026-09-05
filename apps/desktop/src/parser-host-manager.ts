/**
 * Parser host manager.
 *
 * Owns the lifecycle of an Electron `utilityProcess` running the
 * parser-host-entry module. Request/response correlation (pending map,
 * per-request deadline, reject-all on exit/stop, late-response logging) is
 * the shared `createHostRequestChannel`; this file owns only the transport
 * and the parser's "never reject, always answer" response contract. Parsing
 * is stateless: no transactions, no live queries, no draining. Each parse is
 * a single round-trip request/response.
 *
 * Public API: `parse(request)` returns the response. `stop()` kills the
 * host and fails any in-flight requests.
 *
 * See: docs/prd-chunking-wasm-parser-2026-05.md §4
 */

import { createLogger } from '@brainstrike/logging';
import { type UtilityProcess, utilityProcess } from 'electron';
import { resolveBundledSiblingPath } from './bundled-sibling-path';
import type { ParserHostParseRequest, ParserHostParseResponse } from './parser-host-shared';
import { createHostRequestChannel, type HostRequestChannel } from './platform/host-request-channel';

const logger = createLogger('ParserHostManager');
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface ParserHostManagerOptions {
  /** Path to the parser-host-entry.js bundled output. Defaults to a sibling lookup. */
  readonly entryPath?: string;
  /** Per-request timeout in milliseconds. */
  readonly requestTimeoutMs?: number;
}

export function resolveParserHostEntryPath(currentModuleFilename?: string): string {
  return resolveBundledSiblingPath(
    'Parser host entry',
    'parser-host-entry.js',
    currentModuleFilename
  );
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
  readonly #requests: HostRequestChannel<ParserHostParseRequest, ParserHostParseResponse>;

  constructor(options: ParserHostManagerOptions = {}) {
    this.#entryPath = options.entryPath ?? resolveParserHostEntryPath();
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#requests = createHostRequestChannel<ParserHostParseRequest, ParserHostParseResponse>({
      onTimeout: (_request, context) => ({
        error: new Error(`parser host timeout after ${context.timeoutMs}ms`),
        policy: 'abandon',
      }),
      requestId: (request) => request.requestId,
      responseId: (response) => response.requestId,
      role: 'Parser host',
      send: (request) => {
        this.#ensureHost().postMessage(request);
      },
      timeoutMs: () => this.#requestTimeoutMs,
    });
  }

  async parse(request: ParserHostParseRequest): Promise<ParserHostParseResponse> {
    try {
      return await this.#requests.request(request);
    } catch (error) {
      // The parser contract answers every request; failures travel as `ok: false`.
      return {
        error: error instanceof Error ? error.message : String(error),
        ok: false,
        requestId: request.requestId,
      };
    }
  }

  async stop(): Promise<void> {
    const host = this.#host;
    if (host) {
      host.kill();
      this.#host = null;
    }
    this.#requests.rejectAll(new Error('parser host stopped'));
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
      logger.warn('Ignored malformed parser host message', { message });
      return;
    }
    this.#requests.accept(message);
  }

  #handleExit(): void {
    this.#host = null;
    this.#requests.rejectAll(new Error('parser host exited unexpectedly'));
  }
}
