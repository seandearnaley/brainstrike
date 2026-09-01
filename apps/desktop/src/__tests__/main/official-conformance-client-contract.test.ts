import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { McpHostOperation, McpHostOperationResult } from '@brainstrike/assistant-contract';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import {
  type ProductionConformanceClientRuntime,
  runProductionMcpConformanceClient,
} from '../../mcp/official-conformance-client.js';
import {
  parseOfficialConformanceProcessInput,
  runOfficialConformanceProcess,
} from '../../official-conformance-client-process.js';

const SOURCE_PATH = path.resolve(import.meta.dirname, '../../mcp/official-conformance-client.ts');

function closeReport(
  failures: readonly { category: 'operation'; code: string; message: string }[] = []
) {
  return {
    callbacksClosed: 0,
    childProcessesClosed: 0,
    clientsClosed: 1,
    failures,
    loopbackPortsClosed: 0,
    probesClosed: 0,
    requestsSettled: 1,
    subscriptionsClosed: 0,
  } as const;
}

function runtimeReturningToolCall(result: McpHostOperationResult): {
  close: ReturnType<typeof vi.fn>;
  runtime: ProductionConformanceClientRuntime;
} {
  const close = vi.fn(async () => closeReport());
  const runtime = {
    host: {
      close,
      invoke: vi.fn(async (operation: McpHostOperation): Promise<McpHostOperationResult> => {
        if (operation.type === 'tools/list') {
          return {
            result: {
              tools: [{ inputSchema: { type: 'object' }, name: 'add_numbers' }],
            },
            type: 'tools/list',
          };
        }
        return result;
      }),
    },
    replaceResolvedConfig: vi.fn(async () => ({ revision: 1, servers: [] })),
  } satisfies ProductionConformanceClientRuntime;
  return { close, runtime };
}

const INVALID_TOOL_CALL_RESULTS: readonly {
  expected: RegExp;
  result: McpHostOperationResult;
}[] = [
  {
    expected: /invalid tools\/call result/u,
    result: { result: { tools: [] }, type: 'tools/list' },
  },
  {
    expected: /reported a tools\/call error/u,
    result: {
      result: { content: [{ text: 'boom', type: 'text' }], isError: true },
      type: 'tools/call',
    },
  },
];

describe('production MCP conformance client contract', () => {
  it('parses only the official positional URL and exact runner environment', () => {
    expect(
      parseOfficialConformanceProcessInput(['https://mcp.example.test/mcp'], {
        MCP_CONFORMANCE_PROTOCOL_VERSION: '2026-07-28',
        MCP_CONFORMANCE_SCENARIO: 'tools_call',
      })
    ).toEqual({
      protocolVersion: '2026-07-28',
      scenario: 'tools_call',
      serverUrl: 'https://mcp.example.test/mcp',
    });
    expect(() =>
      parseOfficialConformanceProcessInput(['https://user:secret@example.test/mcp'], {
        MCP_CONFORMANCE_PROTOCOL_VERSION: '2026-07-28',
        MCP_CONFORMANCE_SCENARIO: 'tools_call',
      })
    ).toThrow(/credentials/);
  });

  it('fails closed on auth context without exposing it and emits only a fixed error', async () => {
    const secret = 'super-secret-client-value';
    const writeError = vi.fn();
    const runClient = vi.fn();

    await expect(
      runOfficialConformanceProcess(
        ['https://mcp.example.test/mcp'],
        {
          MCP_CONFORMANCE_CONTEXT: JSON.stringify({ clientSecret: secret }),
          MCP_CONFORMANCE_PROTOCOL_VERSION: '2025-11-25',
          MCP_CONFORMANCE_SCENARIO: 'auth/pre-registration',
        },
        { runClient, writeError }
      )
    ).resolves.toBe(1);

    expect(runClient).not.toHaveBeenCalled();
    expect(writeError).toHaveBeenCalledWith('Production MCP conformance client failed\n');
    expect(JSON.stringify(writeError.mock.calls)).not.toContain(secret);
  });

  it('uses the production host runtime without constructing a parallel MCP client', () => {
    const source = readFileSync(SOURCE_PATH, 'utf8');
    const sourceFile = ts.createSourceFile(
      SOURCE_PATH,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    const imports = sourceFile.statements.flatMap((statement) =>
      ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
        ? [statement.moduleSpecifier.text]
        : []
    );

    expect(imports).toContain('./host-runtime');
    expect(imports.some((specifier) => specifier.includes('@modelcontextprotocol/'))).toBe(false);
    expect(imports).not.toContain('./http-client');
    expect(imports).not.toContain('./stdio-client');
  });

  it('closes the host and reports both execution and cleanup failures', async () => {
    const executionFailure = new Error('scenario execution failed');
    const close = vi.fn(async () =>
      closeReport([
        { category: 'operation', code: 'client-close-failed', message: 'cleanup failed' },
      ])
    );
    const runtime = {
      host: {
        close,
        invoke: vi.fn(async () => {
          throw executionFailure;
        }),
      },
      replaceResolvedConfig: vi.fn(async () => ({ revision: 1, servers: [] })),
    } satisfies ProductionConformanceClientRuntime;

    const result = runProductionMcpConformanceClient(
      {
        protocolVersion: '2026-07-28',
        scenario: 'tools_call',
        serverUrl: 'https://mcp.example.test/mcp',
      },
      { createRuntime: () => runtime }
    );

    await expect(result).rejects.toMatchObject({
      errors: [executionFailure, expect.any(Error)],
      message: 'Production MCP conformance client and cleanup failed',
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it.each(INVALID_TOOL_CALL_RESULTS)(
    'rejects $expected instead of recording false conformance',
    async ({ expected, result }) => {
      const { close, runtime } = runtimeReturningToolCall(result);

      await expect(
        runProductionMcpConformanceClient(
          {
            protocolVersion: '2026-07-28',
            scenario: 'tools_call',
            serverUrl: 'https://mcp.example.test/mcp',
          },
          { createRuntime: () => runtime }
        )
      ).rejects.toThrow(expected);
      expect(close).toHaveBeenCalledOnce();
    }
  );
});
