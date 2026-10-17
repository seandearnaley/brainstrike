// @vitest-environment node
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { McpStdioDiagnosticCollector } from '@brainstrike/host-capabilities/mcp/stdio-diagnostics';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { MAIN_PROCESS_BUILD_OPTIONS } from '../../../scripts/build-main-config.mjs';

const APP_ROOT = path.resolve(import.meta.dirname, '../../..');
// The SDK's protected-resource check names the published resource it refused.
const MISMATCH_MESSAGE = 'Protected resource https://evil.example.com/mcp does not match expected';

interface ProcessResult {
  code: number | null;
  sawMismatch: boolean;
  signal: NodeJS.Signals | null;
  stderr: readonly string[];
  timedOut: boolean;
}

async function runChild(
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv
): Promise<ProcessResult> {
  const child = spawn(command, args, {
    cwd: APP_ROOT,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdoutDiagnostics = new McpStdioDiagnosticCollector();
  const stderrDiagnostics = new McpStdioDiagnosticCollector();
  let stdoutTail = '';
  let sawMismatch = false;
  let timedOut = false;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdoutDiagnostics.write(chunk);
    const candidate = stdoutTail + chunk;
    sawMismatch ||= candidate.includes(MISMATCH_MESSAGE);
    stdoutTail = candidate.slice(-(MISMATCH_MESSAGE.length - 1));
  });
  child.stderr.on('data', (chunk: string) => {
    stderrDiagnostics.write(chunk);
  });
  const deadline = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, 45_000);
  try {
    return await new Promise<ProcessResult>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        stdoutDiagnostics.flush();
        stderrDiagnostics.flush();
        resolve({
          code,
          sawMismatch,
          signal,
          stderr: stderrDiagnostics.snapshot().map(({ message }) => message),
          timedOut,
        });
      });
    });
  } finally {
    clearTimeout(deadline);
  }
}

function assertResourceMismatchProof(result: ProcessResult, requests: readonly string[]): void {
  expect(result.timedOut).toBe(false);
  expect(result.code).toBe(1);
  expect(result.signal).toBeNull();
  expect(requests).toContain('POST /mcp');
  expect(requests).toContain('GET /.well-known/oauth-protected-resource/mcp');
  expect(requests.some((request) => request.includes('/authorize'))).toBe(false);
  expect(requests.some((request) => request.includes('/register'))).toBe(false);
  expect(result.sawMismatch).toBe(true);
  expect(
    result.stderr.some((line) => line.includes('Production MCP conformance client failed:'))
  ).toBe(true);
}

it('exits after observing and rejecting a mismatched protected resource', async () => {
  const requests: string[] = [];
  let origin = '';
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', origin).pathname;
    requests.push(`${request.method} ${pathname}`);
    response.setHeader('content-type', 'application/json');
    if (pathname === '/mcp') {
      response.writeHead(401, {
        'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
      });
      response.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (pathname === '/.well-known/oauth-protected-resource/mcp') {
      response.end(
        JSON.stringify({
          authorization_servers: [origin],
          resource: 'https://evil.example.com/mcp',
        })
      );
      return;
    }
    if (pathname === '/.well-known/oauth-authorization-server') {
      response.end(
        JSON.stringify({
          authorization_endpoint: `${origin}/authorize`,
          issuer: origin,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ['code'],
          token_endpoint: `${origin}/token`,
        })
      );
      return;
    }
    response.writeHead(404);
    response.end('{}');
  });
  const outputDir = await mkdtemp(path.join(APP_ROOT, '.official-client-process-test-'));
  const failures: unknown[] = [];

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, 'localhost', () => {
        server.off('error', reject);
        resolve();
      });
    });
    origin = `http://localhost:${(server.address() as AddressInfo).port}`;
    await build({
      ...MAIN_PROCESS_BUILD_OPTIONS,
      entryPoints: {
        'official-conformance-client-entry': 'src/official-conformance-client-entry.ts',
      },
      format: 'cjs',
      logLevel: 'silent',
      outdir: outputDir,
      packages: 'external',
      platform: 'node',
    });
    const environment = {
      ...process.env,
      MCP_CONFORMANCE_CONTEXT: undefined,
      MCP_CONFORMANCE_PROTOCOL_VERSION: '2026-07-28',
      MCP_CONFORMANCE_SCENARIO: 'auth/resource-mismatch',
    };
    const result = await runChild(
      process.execPath,
      [path.join(outputDir, 'official-conformance-client-entry.js'), `${origin}/mcp`],
      environment
    );
    assertResourceMismatchProof(result, requests);

    // Alpha.10 incorrectly passes this negative scenario when the client exits
    // before making a request. This control proves our assertion rejects it.
    requests.length = 0;
    const earlyExit = await runChild(process.execPath, ['-e', 'process.exit(1)'], environment);
    expect(earlyExit.timedOut).toBe(false);
    expect(earlyExit.code).toBe(1);
    expect(() => assertResourceMismatchProof(earlyExit, requests)).toThrow();
  } catch (error) {
    failures.push(error);
  } finally {
    const cleanup = await Promise.allSettled([
      server.listening
        ? new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve()))
          )
        : Promise.resolve(),
      rm(outputDir, { force: true, recursive: true }),
    ]);
    failures.push(
      ...cleanup.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
    );
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Conformance process test and cleanup failed');
  }
}, 60_000);
