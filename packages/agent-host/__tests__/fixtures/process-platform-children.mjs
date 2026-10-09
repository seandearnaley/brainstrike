/**
 * BST-1932 AT-13: a delegating host platform for real host processes. The root
 * hands LEVEL_1 to a background Worker, which hands LEVEL_2 to a foreground
 * Worker; that grandchild pauses on the interaction BRAINSTRIKE_CHILD_RESTART_TOOL
 * names. Only the model is scripted; each process records its pid, every model
 * call and every executed effect under the root.
 */
import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_PERMISSION_POLICIES,
  DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
} from '@brainstrike/assistant-contract';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { z } from 'zod';

const LEDGER = 'Background invocations of this turn';
const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
};
const INTERACTIONS = {
  ask_user: { question: 'Which roots?' },
  submit_plan: { title: 'Grandchild plan' },
  write_file: { path: 'grandchild.txt', text: 'GRANDCHILD_EFFECT' },
};

/** @param {import('ai/test').MockLanguageModelV4['doStreamCalls'][number]['prompt']} prompt */
function userTexts(prompt) {
  return prompt.flatMap((message) =>
    message.role === 'user'
      ? message.content.flatMap((part) => (part.type === 'text' ? [part.text] : []))
      : []
  );
}

/** One scripted step: a tool call, or a final answer. */
function step(next) {
  const chunks =
    'toolName' in next
      ? [
          { type: 'stream-start', warnings: [] },
          {
            input: JSON.stringify(next.input),
            toolCallId: `${next.toolName}-call`,
            toolName: next.toolName,
            type: 'tool-call',
          },
          { finishReason: { raw: 'tool_calls', unified: 'tool-calls' }, type: 'finish', usage },
        ]
      : [
          { type: 'stream-start', warnings: [] },
          { id: 'text-1', type: 'text-start' },
          { delta: next.text, id: 'text-1', type: 'text-delta' },
          { id: 'text-1', type: 'text-end' },
          { finishReason: { raw: 'stop', unified: 'stop' }, type: 'finish', usage },
        ];
  return {
    stream: simulateReadableStream({ chunkDelayInMs: null, chunks, initialDelayInMs: null }),
  };
}

/** @param {string} root @param {keyof typeof INTERACTIONS} interaction */
function treeModel(root, interaction) {
  return new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      const texts = userTexts(prompt);
      const task = texts.at(-1) ?? '';
      const latestUser = prompt.findLastIndex((message) => message.role === 'user');
      const answered = prompt.slice(latestUser).some((message) => message.role === 'tool');
      await appendFile(
        join(root, 'fixture-model-calls'),
        `${JSON.stringify({ ledgers: texts.filter((text) => text.includes(LEDGER)).length, pid: process.pid, task })}\n`
      );
      if (answered) {
        return step({ text: `${task} done.` });
      }
      if (task === 'Delegate the tree.') {
        return step({ input: { prompt: 'LEVEL_1' }, toolName: 'agent-worker' });
      }
      if (task === 'LEVEL_1') {
        return step({ input: { prompt: 'LEVEL_2' }, toolName: 'agent-worker' });
      }
      if (task === 'LEVEL_2') {
        return step({ input: INTERACTIONS[interaction], toolName: interaction });
      }
      return step({ text: `${task} answered.` });
    },
  });
}

/** @param {import('@brainstrike/host-lease').HostStartOptions} options
 * @returns {Promise<import('../../src/ports.js').HostPlatform>} */
export async function createHostPlatform(options) {
  const root = options.root;
  await appendFile(join(root, 'fixture-platform-pids'), `${process.pid}\n`);
  const interaction = z
    .enum(['ask_user', 'submit_plan', 'write_file'])
    .parse(process.env.BRAINSTRIKE_CHILD_RESTART_TOOL);
  const model = treeModel(root, interaction);
  const answer = async (_input, context) => context.resumeData;
  return {
    async close() {},
    delegation: {
      personas: [
        {
          allowedToolIds: ['*'],
          description: 'Delegate an authorized deliverable.',
          id: 'worker',
          instructions: 'You are the Worker subagent.',
          label: 'Worker',
          maxSteps: 4,
          mode: 'worker',
        },
      ],
      settings: { ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS, maxDepth: 2 },
    },
    maxSteps: 4,
    readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
    async resolveModel(modelId) {
      if (modelId !== 'scripted') {
        throw new Error('Unknown fixture model');
      }
      return model;
    },
    tools: {
      ask_user: {
        description: 'Ask the user a question',
        execute: answer,
        identity: 'process-ask-user-generation-1',
        inputSchema: z.object({ question: z.string() }),
        interaction: { kind: 'question', resumeSchema: z.object({ answer: z.string() }) },
        risk: 'read',
      },
      submit_plan: {
        description: 'Submit a plan for approval',
        execute: answer,
        identity: 'process-submit-plan-generation-1',
        inputSchema: z.object({ title: z.string() }),
        interaction: {
          kind: 'plan',
          resumeSchema: z.object({
            action: z.enum(['approved', 'rejected']),
            feedback: z.string().optional(),
          }),
        },
        risk: 'read',
      },
      write_file: {
        description: 'Write an owned file',
        async execute(input) {
          const { path, text } = z.object({ path: z.string(), text: z.string() }).parse(input);
          await appendFile(join(root, 'fixture-effect-count'), '1\n');
          await writeFile(join(root, path), text);
          return { written: path };
        },
        identity: 'process-write-generation-1',
        inputSchema: z.object({ path: z.string(), text: z.string() }),
        risk: 'edit',
      },
    },
  };
}
