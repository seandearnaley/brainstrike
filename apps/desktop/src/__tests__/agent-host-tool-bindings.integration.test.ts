// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildNativeToolRiskMap,
  CEILING_SCALED_TOOL_RESULT_BUDGET,
  type RuntimeData,
} from '@brainstrike/agent';
import { createMcpRuntimeClient } from '@brainstrike/agent/mcp-client';
import {
  type ObservedMcpHostRequest,
  startStatefulMcpHostServer,
} from '@brainstrike/agent/test-fixtures/mcp-host-lifecycle';
import {
  attachAgentHost,
  createMcpHostToolAdapter,
  readHostRow,
  startAgentHost,
} from '@brainstrike/agent-host';
import type { HostEvent, HostLogRow } from '@brainstrike/agent-host/protocol';
import { scriptedToolSequence } from '@brainstrike/agent-host/test-fixtures/scripted-model';
import { foldHostRuns } from '@brainstrike/agent-host/thread-view';
import {
  DEFAULT_PERMISSION_POLICIES,
  NATIVE_TOOL_ID,
  parseConfiguredMcpServerId,
} from '@brainstrike/assistant-contract';
import { RootLock, StateStore } from '@brainstrike/state-store';
import { expect, test } from 'vitest';
import { createAgentHostToolBindings } from '../agent-host-tool-bindings';
import { createReadWorkspaceDirectoryTool } from '../assistant-server/read-workspace-directory-executor';
import { ReadWorkspaceFileCursorRegistry } from '../assistant-server/read-workspace-file-cursor-registry';
import { createDesktopMcpHostRuntime } from '../mcp/host-runtime';

function toolCallCount(requests: readonly ObservedMcpHostRequest[]): number {
  return requests
    .flatMap(({ body }) => (Array.isArray(body) ? body : [body]))
    .filter(
      (body: unknown) =>
        body !== null &&
        typeof body === 'object' &&
        'method' in body &&
        body.method === 'tools/call'
    ).length;
}

test.each(['approve', 'deny'] as const)(
  'canonical reader and HTTP MCP authority compose through the authenticated host (%s)',
  async (decision) => {
    const root = await mkdtemp(join(tmpdir(), 'bs-m3-canonical-tools-'));
    const workspace = await mkdtemp(join(tmpdir(), 'bs-m3-canonical-workspace-'));
    const server = await startStatefulMcpHostServer();
    const authority = createDesktopMcpHostRuntime();
    const configuredServerId = parseConfiguredMcpServerId('fixture.canonical');
    const mcpId = `${configuredServerId}_host_lifecycle_probe`;
    let host: Awaited<ReturnType<typeof startAgentHost>> | undefined;
    let client: Awaited<ReturnType<typeof attachAgentHost>> | undefined;
    let runtimeClient: Awaited<ReturnType<typeof createMcpRuntimeClient>>;
    let adapter: ReturnType<typeof createMcpHostToolAdapter> | undefined;
    let committed: HostLogRow[] = [];
    let threadId: string | undefined;
    try {
      await writeFile(join(workspace, 'canonical-evidence.txt'), 'owned reader evidence');
      await authority.replaceResolvedConfig({
        servers: [
          {
            name: configuredServerId,
            protocol: 'legacy',
            startup: 'automatic',
            transport: 'streamable-http',
            url: server.url,
          },
        ],
      });
      runtimeClient = await createMcpRuntimeClient({ config: undefined, host: authority.host });
      if (!runtimeClient) {
        throw new Error('Canonical MCP runtime did not acquire the host');
      }
      const discovered = await runtimeClient.listToolsetsWithErrors();
      expect(discovered.errors).toEqual({});
      const mcp = discovered.toolsets[configuredServerId]?.['host_lifecycle_probe'];
      if (!mcp) {
        throw new Error('Canonical MCP executor was not discovered');
      }
      const runtimeData: RuntimeData = {
        boundWorkspaceRootId: 'owned-root',
        workspaceRootPath: workspace,
        workspaceRoots: [{ displayName: 'Owned workspace', path: workspace, rootId: 'owned-root' }],
      };
      const read = createReadWorkspaceDirectoryTool({
        dependencies: {},
        isLocalProvider: false,
        readFileCursorRegistry: new ReadWorkspaceFileCursorRegistry(),
        resolveActiveDomainCharBudget: () =>
          CEILING_SCALED_TOOL_RESULT_BUDGET.domainModelResultCharBudget,
        resolvedDomainCharBudget: CEILING_SCALED_TOOL_RESULT_BUDGET.domainModelResultCharBudget,
        runtimeData,
      });
      if (!read) {
        throw new Error('Canonical directory executor is unavailable');
      }
      const generation = authority.host.snapshot().servers[0]?.generation;
      if (!generation) {
        throw new Error('MCP authority has no generation');
      }
      const identity = JSON.stringify([configuredServerId, generation, mcpId]);
      const bindings = createAgentHostToolBindings({
        bindings: {
          [NATIVE_TOOL_ID.readWorkspaceDirectory]: {
            identity: NATIVE_TOOL_ID.readWorkspaceDirectory,
            risk: buildNativeToolRiskMap()[NATIVE_TOOL_ID.readWorkspaceDirectory] ?? 'read',
          },
          [mcpId]: { identity, risk: 'mcp' },
        },
        resolvedToolResultBudget: CEILING_SCALED_TOOL_RESULT_BUDGET,
        tools: { [NATIVE_TOOL_ID.readWorkspaceDirectory]: read, [mcpId]: mcp },
      });
      const nativeName = [...bindings.toolNameMap].find(
        ([, id]) => id === NATIVE_TOOL_ID.readWorkspaceDirectory
      )?.[0];
      const mcpName = [...bindings.toolNameMap].find(([, id]) => id === mcpId)?.[0];
      if (!(nativeName && mcpName && bindings.tools[mcpName])) {
        throw new Error('Host names were not bound');
      }
      adapter = createMcpHostToolAdapter({
        bindings: { [mcpName]: { configuredServerId, generation, tool: bindings.tools[mcpName] } },
        host: authority.host,
      });
      const model = scriptedToolSequence([
        { input: { path: '/', root: 'owned-root' }, toolId: nativeName },
        { input: {}, toolId: mcpName },
      ]);
      host = await startAgentHost(
        { lifetime: 'persistent', root },
        {
          close: async () => {
            await adapter?.close();
            await runtimeClient?.disconnect();
            const report = await authority.host.close();
            expect(report.failures).toEqual([]);
            expect(report.clientsClosed).toBe(1);
          },
          maxSteps: 3,
          readPermissionPolicy: () =>
            bindings.permissionPolicy({
              perToolOverrides: { [mcpId]: 'ask' },
              policies: { ...DEFAULT_PERMISSION_POLICIES },
              yolo: false,
            }),
          resolveModel: async () => model,
          tools: { ...bindings.tools, ...adapter.tools },
        }
      );
      client = await attachAgentHost(host.record);
      ({ threadId } = await client.request('thread/start', { commandId: randomUUID() }));
      const { runId } = await client.request('run/start', {
        commandId: randomUUID(),
        modelId: 'scripted',
        prompt: 'Read the owned folder and call its configured MCP tool.',
        threadId,
      });
      let pending: Extract<HostEvent, { type: 'interaction.requested' }> | undefined;
      await expect
        .poll(async () => {
          committed = (await client!.request('thread/read', { fromSeq: 0, threadId: threadId! }))
            .rows;
          pending = committed
            .map((row) => row.event)
            .find(
              (event): event is NonNullable<typeof pending> =>
                event.type === 'interaction.requested'
            );
          return pending?.toolId;
        })
        .toBe(mcpName);
      expect(
        committed.some(
          (row) =>
            row.event.type === 'effect.finished' &&
            JSON.stringify(row.event.output).includes('canonical-evidence.txt')
        )
      ).toBe(true);
      expect(toolCallCount(server.requests)).toBe(0);
      if (!pending) {
        throw new Error('MCP decision was not committed');
      }
      await client.request('interaction/respond', {
        commandId: randomUUID(),
        decision,
        interactionId: pending.interactionId,
        runId,
        threadId,
      });
      await expect
        .poll(async () => {
          committed = (await client!.request('thread/read', { fromSeq: 0, threadId: threadId! }))
            .rows;
          return committed.at(-1)?.event.type;
        })
        .toBe('run.finished');
      expect(toolCallCount(server.requests)).toBe(decision === 'approve' ? 1 : 0);
      expect(committed.filter(({ event }) => event.type === 'effect.finished')).toHaveLength(
        decision === 'approve' ? 2 : 1
      );
      expect(foldHostRuns(committed)[0]?.status).toBe('completed');
      if (decision === 'approve') {
        expect(foldHostRuns(committed)[0]?.results.at(-1)?.output).toMatchObject({
          content: [{ text: 'ok', type: 'text' }],
        });
      }
      await client.close();
      client = undefined;
      await host.close();
      host = undefined;
      expect(server.requests.at(-1)?.method).toBe('DELETE');
      expect(RootLock.inspect(root)?.owner.released).toBe(true);
      await expect(access(join(root, 'host.json'))).rejects.toThrow();
      const store = await StateStore.open(root);
      try {
        expect(
          foldHostRuns(
            await Promise.all((await store.read(threadId)).map((row) => readHostRow(store, row)))
          )
        ).toEqual(foldHostRuns(committed));
      } finally {
        await store.close();
      }
    } finally {
      await writeFile(
        `/tmp/brainstrike-m3-canonical-bindings-${decision}-log.json`,
        JSON.stringify(committed, null, 2)
      );
      await client?.close();
      await host?.close();
      await adapter?.close();
      await runtimeClient?.disconnect();
      await authority.host.close();
      await server.close();
      await rm(root, { force: true, recursive: true });
      await rm(workspace, { force: true, recursive: true });
    }
  }
);
