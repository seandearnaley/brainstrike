/**
 * End-to-end coverage for Agent Skills through the REAL Mastra agent loop.
 *
 * Deliberately does NOT mock `@mastra/core/agent` (see the LIVE-validation
 * requirement in docs/agents/assistant-runtime.md): it drives the real
 * `streamMastraAgent` path with a scripted language model and asserts the two
 * properties the docs flagged as the skills-adoption blockers:
 *
 * 1. The `skill`/`skill_search`/`skill_read` tools flow through the SAME
 *    guard → hooks → plan-mode → permission pipeline as every native tool
 *    (they are folded into the local tool map BEFORE `new Agent`, never
 *    Agent-level auto-added), so an enforced policy still gates mutations
 *    while skill tools run free as `read`.
 * 2. The SkillsProcessor injects the `<available_skills>` metadata block into
 *    the system context (progressive disclosure level 1), and activating a
 *    skill returns its full instructions as the tool result (level 2).
 */
import { ReadableStream } from 'node:stream/web';
import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2StreamPart,
} from '@ai-sdk/provider';
import { buildNativeToolRiskMap } from '@brainstrike/assistant-contract';
import { createTool } from '@mastra/core/tools';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createScannedWorkspaceSkills,
  type SkillContentDeps,
} from '../skills/scanned-workspace-skills';
import { type SkillScanDeps, scanSkills } from '../skills/skill-scan';
import type { StreamChunk } from '../types';

const { modelHolder } = vi.hoisted(() => ({
  modelHolder: { current: undefined as LanguageModelV2 | undefined },
}));

vi.mock('../providers/provider-factory', async (importActual) => {
  const actual = await importActual<typeof import('../providers/provider-factory')>();
  return {
    ...actual,
    createProvider: () => {
      if (!modelHolder.current) {
        throw new Error('test fake model was not configured');
      }
      return modelHolder.current;
    },
    getDefaultModel: () => 'fake-model',
  };
});

const { streamMastraAgent } = await import('../mastra/agent-runtime');

const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 } as const;

/**
 * Scripted model that records every prompt it receives, emits one tool call on
 * the first turn, and a final text answer once the prompt carries a tool result.
 */
function createPromptCapturingToolCallModel(args: {
  toolName: string;
  input: string;
  finalText: string;
  prompts: LanguageModelV2CallOptions['prompt'][];
}): LanguageModelV2 {
  const enqueue = (parts: LanguageModelV2StreamPart[]) =>
    new ReadableStream<LanguageModelV2StreamPart>({
      start(controller) {
        for (const part of parts) {
          controller.enqueue(part);
        }
        controller.close();
      },
    });

  return {
    doGenerate: () => Promise.reject(new Error('doGenerate is not used by this test')),
    doStream: (options: LanguageModelV2CallOptions) => {
      args.prompts.push(options.prompt);
      const promptHasToolResult =
        Array.isArray(options.prompt) && options.prompt.some((message) => message.role === 'tool');
      if (promptHasToolResult) {
        const id = 'text-final';
        return Promise.resolve({
          stream: enqueue([
            { type: 'stream-start', warnings: [] },
            { id, type: 'text-start' },
            { delta: args.finalText, id, type: 'text-delta' },
            { id, type: 'text-end' },
            { finishReason: 'stop', type: 'finish', usage: USAGE },
          ]),
        });
      }
      return Promise.resolve({
        stream: enqueue([
          { type: 'stream-start', warnings: [] },
          {
            input: args.input,
            toolCallId: 'call-skill-1',
            toolName: args.toolName,
            type: 'tool-call',
          },
          { finishReason: 'tool-calls', type: 'finish', usage: USAGE },
        ]),
      });
    },
    modelId: 'fake-model',
    provider: 'fake',
    specificationVersion: 'v2',
    supportedUrls: {},
  };
}

const SKILLS_DIR = '/proj/a/.brainstrike/skills';

interface MemoryFs {
  dirs: Record<string, readonly { name: string; kind: 'file' | 'dir' }[]>;
  files: Record<string, string>;
}

function fixtureFs(): MemoryFs {
  return {
    dirs: {
      [SKILLS_DIR]: [{ kind: 'dir', name: 'pdf-processing' }],
      [`${SKILLS_DIR}/pdf-processing`]: [{ kind: 'file', name: 'SKILL.md' }],
    },
    files: {
      [`${SKILLS_DIR}/pdf-processing/SKILL.md`]:
        '---\nname: pdf-processing\ndescription: Extract text from PDF files.\n---\nUse pdfplumber to extract text from PDFs.',
    },
  };
}

function makeScanDeps(fs: MemoryFs): SkillScanDeps {
  return {
    listDir: (absDir, _containmentRoot, maxEntries) => {
      const entries = fs.dirs[absDir];
      if (!entries) {
        return null;
      }
      return {
        entries: entries.slice(0, maxEntries).map((entry) => ({
          isDirectory: entry.kind === 'dir',
          isFile: entry.kind === 'file',
          name: entry.name,
        })),
        inspected: Math.min(entries.length, maxEntries),
        truncated: entries.length > maxEntries,
      };
    },
    readFile: (absFile) =>
      absFile in fs.files
        ? { content: fs.files[absFile] as string, ok: true }
        : { ok: false, reason: 'unreadable' },
  };
}

function makeEngine(fs: MemoryFs) {
  const scanDeps = makeScanDeps(fs);
  const contentDeps: SkillContentDeps = {
    listDir: scanDeps.listDir,
    readFileBytes: (absFile) =>
      absFile in fs.files
        ? { content: new TextEncoder().encode(fs.files[absFile] as string), ok: true }
        : { ok: false, reason: 'unreadable' },
    readFileText: scanDeps.readFile,
  };
  return createScannedWorkspaceSkills({
    deps: contentDeps,
    scan: () =>
      scanSkills(
        { homeDir: '/home/user', roots: [{ absPath: '/proj/a', displayName: 'A', id: 'root-a' }] },
        scanDeps
      ),
  });
}

async function drain(iterator: AsyncIterableIterator<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of iterator) {
    chunks.push(chunk);
  }
  return chunks;
}

function systemText(prompt: LanguageModelV2CallOptions['prompt']): string {
  if (!Array.isArray(prompt)) {
    return '';
  }
  return prompt
    .filter((message) => message.role === 'system')
    .map((message) => (typeof message.content === 'string' ? message.content : ''))
    .join('\n');
}

describe('mastra agent skills (real @mastra/core/agent)', () => {
  beforeEach(() => {
    modelHolder.current = undefined;
  });

  it('injects available-skills metadata and activates a skill through the real loop', async () => {
    const prompts: LanguageModelV2CallOptions['prompt'][] = [];
    modelHolder.current = createPromptCapturingToolCallModel({
      finalText: 'Activated the pdf skill.',
      input: JSON.stringify({ name: 'pdf-processing' }),
      prompts,
      toolName: 'skill',
    });

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'extract text from this pdf', type: 'text' }], role: 'user' }],
      {
        runtime: {
          apiKey: 'test-key',
          provider: 'openai',
          workspaceSkills: makeEngine(fixtureFs()),
        },
      }
    );

    const chunks = await drain(iterator);
    const runEventKinds = chunks.flatMap((chunk) =>
      chunk.type === 'run-event' ? [chunk.event.kind] : []
    );
    expect(runEventKinds).toContain('tool.completed');

    // Level 1: the metadata block reached the system context on the FIRST call.
    const firstSystem = systemText(prompts[0] ?? []);
    expect(firstSystem).toContain('<available_skills>');
    expect(firstSystem).toContain('pdf-processing');
    expect(firstSystem).toContain('Extract text from PDF files.');

    // Level 2: activation returned the instructions to the model (visible in
    // the second call's tool-result message).
    const secondPrompt = prompts[1] ?? [];
    const toolResultText = JSON.stringify(secondPrompt);
    expect(toolResultText).toContain('pdfplumber');
  });

  it('runs skill tools FREE under an enforced policy while an ask tool still gates', async () => {
    const askExecute = vi.fn(() => Promise.resolve({ ran: 'yes' }));
    const askTool = createTool({
      description: 'An execute-risk tool gated to ask.',
      execute: askExecute,
      id: 'shell_tool',
      inputSchema: z.object({ command: z.string() }),
      outputSchema: z.object({ ran: z.string() }),
    });

    const prompts: LanguageModelV2CallOptions['prompt'][] = [];
    modelHolder.current = createPromptCapturingToolCallModel({
      finalText: 'Skill loaded without approval.',
      input: JSON.stringify({ name: 'pdf-processing' }),
      prompts,
      toolName: 'skill',
    });

    const iterator = await streamMastraAgent(
      [{ id: 'u2', parts: [{ text: 'use the pdf skill', type: 'text' }], role: 'user' }],
      {
        runtime: {
          apiKey: 'test-key',
          permissionPolicy: {
            policies: { edit: 'deny', execute: 'ask', mcp: 'allow', read: 'allow' },
            riskByTool: { ...buildNativeToolRiskMap(), shell_tool: 'execute' },
            yolo: false,
          },
          provider: 'openai',
          workspaceSkills: makeEngine(fixtureFs()),
        },
        tools: { shell_tool: askTool },
      }
    );

    const chunks = await drain(iterator);
    // Without workflow storage, ask tools are fail-safe omitted — but the skill
    // tool (read) must still have executed to completion, unsuspended.
    const runEventKinds = chunks.flatMap((chunk) =>
      chunk.type === 'run-event' ? [chunk.event.kind] : []
    );
    expect(runEventKinds).toContain('tool.completed');
    expect(askExecute).not.toHaveBeenCalled();
    const toolResultText = JSON.stringify(prompts[1] ?? []);
    expect(toolResultText).toContain('pdfplumber');
  });

  it('keeps skill tools available in plan mode (read/investigation tools)', async () => {
    const prompts: LanguageModelV2CallOptions['prompt'][] = [];
    modelHolder.current = createPromptCapturingToolCallModel({
      finalText: 'Planned with skill context.',
      input: JSON.stringify({ name: 'pdf-processing' }),
      prompts,
      toolName: 'skill',
    });

    const iterator = await streamMastraAgent(
      [{ id: 'u3', parts: [{ text: 'plan the pdf work', type: 'text' }], role: 'user' }],
      {
        runtime: {
          apiKey: 'test-key',
          planMode: true,
          provider: 'openai',
          workspaceSkills: makeEngine(fixtureFs()),
        },
      }
    );

    const chunks = await drain(iterator);
    const runEventKinds = chunks.flatMap((chunk) =>
      chunk.type === 'run-event' ? [chunk.event.kind] : []
    );
    expect(runEventKinds).toContain('tool.completed');
    const toolResultText = JSON.stringify(prompts[1] ?? []);
    expect(toolResultText).toContain('pdfplumber');
  });

  it('advertises skills guidance in the instructions only when skills are attached', async () => {
    const prompts: LanguageModelV2CallOptions['prompt'][] = [];
    modelHolder.current = createPromptCapturingToolCallModel({
      finalText: 'No skills here.',
      input: JSON.stringify({ name: 'pdf-processing' }),
      prompts,
      toolName: 'skill',
    });

    const iterator = await streamMastraAgent(
      [{ id: 'u4', parts: [{ text: 'hello', type: 'text' }], role: 'user' }],
      { runtime: { apiKey: 'test-key', provider: 'openai' } }
    );
    // Without workspaceSkills the model has no `skill` tool: the scripted call
    // fails as an unknown tool, but the system prompt must not advertise skills.
    await drain(iterator).catch(() => []);
    const firstSystem = systemText(prompts[0] ?? []);
    expect(firstSystem).not.toContain('<available_skills>');
    expect(firstSystem).not.toMatch(/skill_search/);
  });
});
