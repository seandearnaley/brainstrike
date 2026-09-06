/**
 * Shared transport-test harness for the assistant-server suites (BST-1028).
 *
 * Extracted verbatim from the pre-split assistant-server.integration.test.ts.
 * Deliberately contains NO `vi.mock` calls and imports NO production module:
 * `vi.mock(<literal path>)` CALL SITES are hoisted per-importing-module by
 * the Vite transform, so they cannot live here — each test file declares its
 * own; the factory BODIES are shared from _assistant-server-mocks.ts
 * (BST-1029), reached via a vi.hoisted dynamic-import accessor because the
 * hoisted calls evaluate their arguments before static imports initialize.
 * Taking the request handler as a parameter keeps this file outside every
 * mocked graph. The `_`-prefixed name carries no `.test.` segment, so neither
 * vitest lane collects it as a suite.
 */
import { EventEmitter } from 'node:events';
import type http from 'node:http';
import { Readable } from 'node:stream';
// Type-only: erased by the transform, so no production module executes here.
import type { AssistantServerOptions } from '../../assistant-server/server-options';

export interface RequestInput {
  body?: string;
  headers?: http.IncomingHttpHeaders;
  method: string;
  url: string;
}

export class MockRequest extends Readable {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  // `string | undefined` (not `?:`): _read() clears by assignment, and the
  // explicit union is what exactOptionalPropertyTypes-strict tooling expects.
  // NOTE: like the test files around it, this module is NOT in the desktop
  // tsc project today (tsconfig excludes src/**/__tests__/** and no script
  // wires tsconfig.test.json) — it compiles under vitest's transform only.
  private payload: string | undefined;

  constructor(input: RequestInput) {
    super();
    this.method = input.method;
    this.url = input.url;
    this.headers = input.headers ?? {};
    this.payload = input.body;
  }

  override _read(): void {
    if (this.payload !== undefined) {
      this.push(this.payload);
    }
    this.payload = undefined;
    this.push(null);
  }
}

export class MockResponse extends EventEmitter {
  statusCode = 200;
  headers: Record<string, string> = {};
  bodyChunks: Buffer[] = [];
  destroyed = false;

  setHeader(name: string, value: string | number | readonly string[]): void {
    this.headers[name.toLowerCase()] = Array.isArray(value) ? value.join(',') : String(value);
  }

  removeHeader(name: string): void {
    delete this.headers[name.toLowerCase()];
  }

  writeHead(status: number, headers?: Record<string, string>): this {
    this.statusCode = status;
    if (headers) {
      for (const [key, value] of Object.entries(headers)) {
        this.setHeader(key, value);
      }
    }
    return this;
  }

  write(chunk: unknown): boolean {
    if (chunk === undefined || chunk === null) {
      return true;
    }
    const buffer = Buffer.isBuffer(chunk)
      ? Buffer.from(chunk)
      : chunk instanceof Uint8Array
        ? Buffer.from(chunk)
        : chunk instanceof ArrayBuffer
          ? Buffer.from(new Uint8Array(chunk))
          : ArrayBuffer.isView(chunk)
            ? Buffer.from(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
            : Buffer.from(String(chunk));
    this.bodyChunks.push(buffer);
    return true;
  }

  end(chunk?: unknown): void {
    if (chunk !== undefined) {
      this.write(chunk);
    }
    this.emit('finish');
  }
}

export interface RunRequestResult {
  body: string;
  headers: Record<string, string>;
  status: number;
}

type AssistantRequestHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options?: AssistantServerOptions
) => Promise<void>;

/**
 * Build a `runRequest` bound to the (possibly mock-wrapped) handler the test
 * file imported. Auth is explicitly disabled by default so suites stay focused
 * on their own concern; the auth-gate suite passes explicit options.
 */
export function createRunRequest(handleAssistantRequest: AssistantRequestHandler) {
  return async function runRequest(
    input: RequestInput,
    serverOptions?: AssistantServerOptions
  ): Promise<RunRequestResult> {
    const req = new MockRequest(input);
    const res = new MockResponse();
    const finished = new Promise<void>((resolve) => res.once('finish', resolve));

    await handleAssistantRequest(
      req as unknown as http.IncomingMessage,
      res as unknown as http.ServerResponse,
      { auth: 'disabled', ...serverOptions }
    );
    await finished;

    return {
      body: Buffer.concat(res.bodyChunks).toString('utf-8'),
      headers: res.headers,
      status: res.statusCode,
    };
  };
}
