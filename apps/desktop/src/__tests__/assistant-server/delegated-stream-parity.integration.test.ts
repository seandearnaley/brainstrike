// @vitest-environment node
/** Script only model transport and DB handle injection; use the real desktop memory,
 * Mastra stream mapper, durable host authority, and existing usage writer. */

import {
  hasToolResult,
  scriptedAgentModel,
  textParts,
  toolCallParts,
} from '@brainstrike/agent/test-fixtures/scripted-agent-model';
import type { DelegatedConversationStreamData } from '@brainstrike/assistant-contract/delegated-conversation-stream';
import { DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS } from '@brainstrike/assistant-contract/memory-settings';
import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract/personas';
import {
  createAssistantThreadHistoryAdapter,
  createPgliteAssistantThreadRepository,
} from '@brainstrike/assistant-data';
import { migrate, wasmLoader } from '@brainstrike/db';
import { createEnginePglite } from '@brainstrike/db/pglite-factory';
import type { DbHandle } from '@brainstrike/db/react';
import type { PGlite } from '@electric-sql/pglite';
import {
  type AssistantMessage,
  AssistantMessageAccumulator,
  DataStreamDecoder,
} from 'assistant-stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { getDesktopMastraMemory } from '../../assistant-server/mastra-memory';
import { observeDesktopAssistantRunEvents } from '../../assistant-server/run-persistence';

const holder = vi.hoisted(() => ({
  database: undefined as PGlite | undefined,
  model: undefined as ReturnType<typeof scriptedAgentModel>['model'] | undefined,
}));
vi.mock('../../db-main', () => ({
  getDatabase: async () => {
    if (!holder.database) {
      throw new Error('Database not initialized');
    }
    return holder.database;
  },
}));
// Restore the real runtime: the desktop global setup installs inert agent mocks.
vi.mock('@brainstrike/agent', async (original) => ({
  ...(await original<typeof import('@brainstrike/agent')>()),
}));
vi.mock('@brainstrike/agent/providers/provider-factory', async (original) => ({
  ...(await original<{ createProvider: typeof import('@brainstrike/agent')['createProvider'] }>()),
  createProvider: () => {
    if (!holder.model) {
      throw new Error('Model not initialized');
    }
    return holder.model;
  },
}));
const { streamMastraAgent, createStatelessAssistantDataStreamResponse } = await import(
  '@brainstrike/agent'
);

const settings = {
  ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
  observationalMemory: {
    ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.observationalMemory,
    enabled: false,
  },
};
const persona: AssistantPersonaDefinition = {
  allowedToolIds: ['brainstrike.grepSearch'],
  description: 'Find the requested flag.',
  id: 'explore',
  instructions: 'Read and report the flag.',
  label: 'Explorer',
  maxSteps: 8,
};

describe('desktop child transport and native row parity', () => {
  afterEach(async () => {
    await holder.database?.close();
    holder.database = undefined;
    holder.model = undefined;
  });

  let database: PGlite;
  // The suite's existing database hook timeout owns full migration setup.
  beforeEach(async () => {
    database = await wasmLoader.createPGlite('memory://delegated-runtime');
    holder.database = database;
    await migrate(database);
    await database.exec(`INSERT INTO mastra_threads
      (id, "resourceId", title, metadata, "createdAt", "updatedAt")
      VALUES ('root', 'owner', 'Root', '{}', NOW(), NOW());
      INSERT INTO brainstrike_assistant_thread_runs
      (id, resource_id, thread_id, provider, model, runtime_kind, status,
       started_at, created_at, updated_at, turn_message_id)
      VALUES ('host-leg', 'owner', 'root', 'openai', 'test', 'desktop', 'running',
        NOW(), NOW(), NOW(), 'user-turn');`);
  });

  it('retains child content and lifecycle order through live decoding and native reconstruction', async () => {
    holder.model = scriptedAgentModel((options) => {
      if (options.tools?.some((tool) => tool.name === 'agent-explore')) {
        return hasToolResult(options, 'agent-explore')
          ? textParts('Parent summary.')
          : toolCallParts('agent-explore', 'delegation-call', { prompt: 'find the flag' });
      }
      if (hasToolResult(options, 'brainstrike_grepSearch')) {
        return textParts('Child final.');
      }
      return [
        ...textParts('Child before.').slice(0, -1),
        { id: 'reasoning', type: 'reasoning-start' },
        { delta: 'Search the source.', id: 'reasoning', type: 'reasoning-delta' },
        { id: 'reasoning', type: 'reasoning-end' },
        ...toolCallParts('brainstrike_grepSearch', 'child-call', { pattern: 'flag' }).slice(1),
      ];
    }).model;
    const memory = await getDesktopMastraMemory(settings, 'host-leg');
    const stream = await streamMastraAgent(
      [{ id: 'user-turn', parts: [{ text: 'find the flag', type: 'text' }], role: 'user' }],
      {
        ...memory,
        personas: [persona],
        runtime: {
          apiKey: 'test-key',
          memory: { memorySettings: settings, resourceId: 'owner', threadId: 'root' },
          model: 'test',
          provider: 'openai',
        },
        tools: {
          'brainstrike.grepSearch': {
            description: 'Read flags',
            execute: async () => ({ matches: ['FLAG-42'] }),
            id: 'brainstrike.grepSearch',
            inputSchema: z.object({ pattern: z.string() }),
          },
        },
      }
    );
    const response = createStatelessAssistantDataStreamResponse(
      observeDesktopAssistantRunEvents(stream, 'host-leg', [], async () => database),
      { messageId: 'parent-message' }
    );
    const lines = (await response.text()).trim().split('\n');
    const envelopes: DelegatedConversationStreamData[] = [];
    for (const line of lines) {
      if (!line.startsWith('aui-data:')) {
        continue;
      }
      const part = JSON.parse(line.slice('aui-data:'.length)) as {
        name: string;
        data: DelegatedConversationStreamData;
      };
      if (part.name === 'brainstrike.delegated-conversation') {
        envelopes.push(part.data);
      }
    }
    const frames = envelopes.flatMap((envelope) => envelope.frames);
    const childResponse = new Response(
      frames.map((frame) => `${frame.code}:${JSON.stringify(frame.value)}\n`).join('')
    );
    if (!childResponse.body) {
      throw new Error('Missing child response');
    }
    let decoded: AssistantMessage | undefined;
    for await (const message of childResponse.body
      .pipeThrough(new DataStreamDecoder())
      .pipeThrough(new AssistantMessageAccumulator())) {
      decoded = message;
    }
    expect(decoded).toBeDefined();
    const children = (
      await database.query<{ thread_id: string; resource_id: string }>(
        "SELECT thread_id, resource_id FROM brainstrike_delegated_conversations WHERE parent_thread_id = 'root'"
      )
    ).rows;
    expect(children).toHaveLength(1);
    const child = children[0];
    if (!child) {
      throw new Error('Missing native child');
    }
    const nativeRows = (
      await database.query<{ id: string; content: unknown }>(
        "SELECT id, content FROM mastra_messages WHERE thread_id = $1 AND role = 'assistant'",
        [child.thread_id]
      )
    ).rows;
    const observedIds = [...new Set(envelopes.map((envelope) => envelope.messageId))];
    expect(decoded?.parts.find((part) => part.type === 'tool-call')).toMatchObject({
      args: { pattern: 'flag' },
      toolCallId: 'child-call',
    });
    expect(nativeRows).toHaveLength(1);
    expect(observedIds).toHaveLength(1);
    expect(nativeRows[0]?.id).toBe(observedIds[0]);
    const reconstructed = await createEnginePglite({ loadDataDir: await database.dumpDataDir() });
    try {
      const load = (db: PGlite) =>
        createAssistantThreadHistoryAdapter({
          repository: createPgliteAssistantThreadRepository(db as unknown as DbHandle),
          resourceId: child.resource_id,
          threadId: child.thread_id,
        }).load();
      const history = await load(database);
      expect(await load(reconstructed)).toEqual(history);
      const contentSchema = z.discriminatedUnion('type', [
        z.object({
          data: z.unknown(),
          name: z.literal('brainstrike.run-event'),
          type: z.literal('data'),
        }),
        z.object({ text: z.string(), type: z.literal('text') }),
        z.object({ text: z.string(), type: z.literal('reasoning') }),
        z.object({
          args: z.object({ pattern: z.string() }),
          result: z.object({ matches: z.array(z.string()) }),
          toolCallId: z.string(),
          toolName: z.string(),
          type: z.literal('tool-call'),
        }),
      ]);
      const transcriptParts = (parts: readonly { type: string }[]) =>
        parts
          .filter(
            (part) =>
              part.type === 'text' ||
              part.type === 'reasoning' ||
              part.type === 'tool-call' ||
              part.type === 'data'
          )
          .map((part) => contentSchema.parse(part));
      const hydratedParts = history.messages.flatMap(({ message }) =>
        message.role === 'assistant' ? message.content : []
      );
      // Parse the known fixture input/result to exclude decoder-private Symbols.
      // Object equality preserves all event data without depending on JSONB key order.
      expect(transcriptParts(hydratedParts)).toEqual(transcriptParts(decoded?.parts ?? []));
      expect(
        transcriptParts(hydratedParts)
          .filter((part) => part.type !== 'data')
          .map((part) => part.type)
      ).toEqual(['text', 'reasoning', 'tool-call', 'text']);
      expect(JSON.stringify(hydratedParts)).not.toContain('Parent summary.');
    } finally {
      await reconstructed.close();
    }
  });
});
