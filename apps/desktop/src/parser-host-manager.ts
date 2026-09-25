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
import { isParserHostParseResponse } from './parser-host-schema';
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

/** Longest content-derived string this summary will repeat into a log. */
const MAX_SUMMARY_STRING_LENGTH = 64;
/** Most keys this summary will name; the full count is always reported. */
const MAX_SUMMARY_KEYS = 20;

function truncateForLog(value: string): string {
  return value.length <= MAX_SUMMARY_STRING_LENGTH
    ? value
    : `${value.slice(0, MAX_SUMMARY_STRING_LENGTH)}…`;
}

/**
 * Describe an unusable host message without logging it. Parser traffic carries
 * user source text and ASTs, so the raw payload must never reach the log:
 * only its shape does. `parser-host-entry` posts nothing but
 * `ParserHostParseResponse` frames (no handshake/ready/log frames), so every
 * message that fails this check is a real fault, not normal traffic.
 *
 * Every field here is bounded, because a malformed frame's *shape* is
 * content-controlled too: a mis-serialized response can put source text in a
 * key or in `type`, and a record keyed by identifier or path has as many keys
 * as the payload has content. Counts are exact; the strings behind them are
 * truncated.
 */
function summarizeMalformedMessage(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    return { messageType: value === null ? 'null' : typeof value };
  }
  if (Array.isArray(value)) {
    // Keys of a large array would be as unbounded as the payload itself.
    return { length: value.length, messageType: 'array' };
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return {
    keyCount: keys.length,
    keys: keys.slice(0, MAX_SUMMARY_KEYS).map(truncateForLog),
    messageType: 'object',
    ...(typeof record['type'] === 'string' ? { type: truncateForLog(record['type']) } : {}),
  };
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
        try {
          this.#ensureHost().postMessage(request);
        } catch (error) {
          // A failed fork or postMessage is an infrastructure fault, not a
          // parse failure. `parse()` converts it to `ok: false` per the
          // always-answer contract, so without this it would be visible only
          // to whoever inspects the response object.
          logger.error('Parser host request could not be sent', {
            error,
            requestId: request.requestId,
          });
          throw error;
        }
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
      logger.warn('Ignored malformed parser host message', summarizeMalformedMessage(message));
      return;
    }
    this.#requests.accept(message);
  }

  #handleExit(): void {
    this.#host = null;
    this.#requests.rejectAll(new Error('parser host exited unexpectedly'));
  }
}
