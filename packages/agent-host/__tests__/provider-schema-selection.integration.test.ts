import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiKeyAuthInput, type RuntimeData } from '@brainstrike/agent/provider-runtime';
import { resolveScaledToolResultBudget } from '@brainstrike/agent/tool-runtime';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { RootLock, StateStore } from '@brainstrike/state-store';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { HostCore } from '../src/core.js';
import {
  createProductionHostPlatform,
  type ProductionHostRunConfiguration,
} from '../src/production-platform.js';
import type { HostEvent } from '../src/protocol.js';

const candidate = join(import.meta.dirname, '../../..');
const recorded = z
  .object({ payloads: z.record(z.string(), z.json()) })
  .parse(
    JSON.parse(
      await readFile(
        join(
          candidate,
          'packages/agent/src/__tests__/fixtures/provider-requests/sdk7-recorded-payloads.json'
        ),
        'utf8'
      )
    )
  );

afterEach(() => vi.unstubAllGlobals());

test.each([
  ['openai', 'gpt-6-sol'],
  ['anthropic', 'claude-sonnet-5'],
  ['google', 'gemini-3.1-pro-preview'],
] as const)(
  'production host applies the existing %s model-facing native schema conversion',
  async (provider, modelId) => {
    const root = await mkdtemp(join(tmpdir(), 'bs-m3-provider-schema-'));
    const configuration: RuntimeData = { model: modelId, provider };
    const bodies: unknown[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      bodies.push(JSON.parse(await request.text()));
      return Response.json(
        {
          error: {
            message: 'Offline fixture stops after request serialization',
            type: 'fixture_terminal',
          },
        },
        { status: 400 }
      );
    });
    vi.stubGlobal('fetch', fetch);
    const store = await StateStore.open(root, {
      memoryCalculatorModule: join(
        candidate,
        'packages/agent-host/dist/adapters/memory-storage-calculator.js'
      ),
    });
    let core: HostCore | undefined;
    let effects = 0;
    try {
      const platform = await createProductionHostPlatform({
        close: async () => undefined,
        readConfiguration: async (): Promise<ProductionHostRunConfiguration> => ({
          configuration,
          durableConfiguration: { model: modelId, provider },
          maxSteps: 1,
          memory: {
            native: {
              options: {
                observationalMemory: false,
                semanticRecall: false,
                workingMemory: { enabled: false },
              },
            },
            recordPrompt: async () => undefined,
            resourceId: 'm3-provider-schema-fixture',
          },
          providerRequestContext: { inputTokenLimit: 5000, provider, runtimeData: configuration },
          resolvedToolResultBudget: resolveScaledToolResultBudget(20_000),
          tools: {
            read: {
              description: 'Read a workspace file',
              execute: async () => {
                effects += 1;
                return {};
              },
              identity: 'recorded-native-read',
              // Exact authored input from the existing SDK7 recorded request.
              // This is a native schema; server-owned MCP omission is separate.
              inputSchema: z.object({ line: z.number().int().optional(), path: z.string() }),
              risk: 'read',
            },
          },
          toolTimeoutMs: 1000,
        }),
        readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
        resolveProviderAuth: async () => apiKeyAuthInput('offline-fixture-key'),
        startup: { register: async () => undefined, signal: new AbortController().signal, store },
      });
      core = await HostCore.open(store, platform, () => () => undefined);
      const { threadId } = await core.startThread({ commandId: randomUUID() });
      const { runId } = await core.startRun({
        commandId: randomUUID(),
        modelId,
        prompt: 'Read README.md',
        threadId,
      });
      const opened = core;
      let terminal: Extract<HostEvent, { type: 'run.finished' }> | undefined;
      await expect
        .poll(async () => {
          terminal = (await opened.read(threadId, 0))
            .map((row) => row.event)
            .find(
              (event): event is Extract<HostEvent, { type: 'run.finished' }> =>
                event.type === 'run.finished' && event.runId === runId
            );
          return terminal !== undefined;
        })
        .toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(effects).toBe(0);
      expect(terminal?.outcome).toBe('failed');
      const actual = z.object({ tools: z.json() }).parse(bodies[0]);
      const reference = z.object({ tools: z.json() }).parse(recorded.payloads[provider]);
      // Compare the actual new-host serialized model-facing schema with the
      // shipped layer receipt. This does not claim a live provider rejected it.
      expect(actual.tools).toEqual(reference.tools);
    } finally {
      await core?.close();
      await store.close();
      expect(RootLock.inspect(root)?.owner.released).toBe(true);
      await rm(root, { force: true, recursive: true });
    }
  }
);
