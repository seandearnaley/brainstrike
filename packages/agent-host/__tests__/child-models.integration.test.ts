/**
 * ADR-0037: a subagent runs on the model its persona pins or its delegation
 * names, admitted on that model as any run is, at the effort it asks for. One
 * that cannot be admitted is refused to the parent's model, never run on the
 * parent's model instead.
 */
import {
  type ChildEffort,
  ChildModelError,
  type ChildModelTarget,
} from '@brainstrike/assistant-contract/child-model';
import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract/personas';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import type { HostPlatform } from '../src/ports.js';
import {
  type CallOptions,
  childThreads,
  finished,
  rowsUntil,
  setupChildRunHost,
  stream,
  text,
  toolCall,
  toolNames,
  toolResults,
  userTexts,
} from './fixtures/child-run-host.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

const TASK = 'MODEL_TASK: survey the workspace.';
const CHILD_ANSWER = 'Answer from the child model.';
const PINNED = 'openrouter::anthropic/claude-opus-5.5';
const ALLOWED = 'google::gemini-3.8-flash';

const reviewer: AssistantPersonaDefinition = {
  allowedToolIds: ['read_file'],
  description: 'Reviews the workspace.',
  id: 'review',
  instructions: 'You are the Reviewer subagent.',
  label: 'Reviewer',
  maxSteps: 4,
  mode: 'read-only',
};

/** A parent that delegates once, in the foreground, then reads the result. */
function parentModel(toolName: string, input: Record<string, unknown>) {
  return new MockLanguageModelV4({
    doStream: async (call) => {
      if (userTexts(call).some((value) => value.startsWith('MODEL_TASK'))) {
        return stream(text('Answer from the parent model.'));
      }
      if (!call.prompt.some((message) => message.role === 'tool')) {
        return stream(
          toolCall(
            toolName,
            { _background: { enabled: false }, prompt: TASK, ...input },
            'model-delegation'
          )
        );
      }
      return stream(text('Parent continues.'));
    },
  });
}

function childModel() {
  return new MockLanguageModelV4({ doStream: async () => stream(text(CHILD_ANSWER)) });
}

interface Scenario {
  readonly childConfiguration?: HostPlatform['childConfiguration'];
  readonly input?: Record<string, unknown>;
  readonly models?: readonly { efforts: readonly ChildEffort[]; id: string; label: string }[];
  readonly persona: AssistantPersonaDefinition;
}

async function delegate(scenario: Scenario) {
  const parent = parentModel(`agent-${scenario.persona.id}`, scenario.input ?? {});
  const child = childModel();
  const targets: ChildModelTarget[] = [];
  const harness = await setupChildRunHost(parent, cleanup, {
    childConfiguration:
      scenario.childConfiguration ??
      ((_configuration, target) => {
        targets.push(target);
        return { childModel: target.modelId };
      }),
    ...(scenario.models ? { models: scenario.models } : {}),
    personas: [scenario.persona],
    resolveModel: async (modelId) => (modelId === 'scripted' ? parent : child),
  });
  const runId = await harness.start('Delegate.');
  await rowsUntil(harness, harness.threadId, finished(runId), 5000);
  const resultCall = parent.doStreamCalls.find((call) =>
    call.prompt.some((message) => message.role === 'tool')
  );
  return { child, harness, parent, resultCall, targets };
}

/** An optional enum property of the offered `agent-review` tool: strict schemas wrap it with null. */
function offeredEnum(parent: MockLanguageModelV4, property: string): unknown[] | undefined {
  const tool = parent.doStreamCalls[0]?.tools?.find((offered) => offered.name === 'agent-review');
  const schema = (tool?.type === 'function' ? tool.inputSchema : undefined) as
    | { properties?: Record<string, { anyOf?: { enum?: unknown[] }[] }> }
    | undefined;
  return schema?.properties?.[property]?.anyOf?.find((branch) => branch.enum)?.enum;
}

function resultText(call: CallOptions | undefined): string {
  return JSON.stringify(call ? toolResults(call) : []);
}

test("a pinned persona's subagent runs on its pinned model at its effort, and its thread stays on it", async () => {
  const { child, harness, parent, resultCall, targets } = await delegate({
    persona: {
      ...reviewer,
      model: { effort: 'high', modelId: 'anthropic/claude-opus-5.5', provider: 'openrouter' },
    },
  });

  expect(targets).toEqual([{ effort: 'high', modelId: PINNED }]);
  // The child's model did the work; the parent's never saw the task.
  expect(child.doStreamCalls.some((call) => userTexts(call).includes(TASK))).toBe(true);
  expect(parent.doStreamCalls.some((call) => userTexts(call).includes(TASK))).toBe(false);
  expect(resultText(resultCall)).toContain(CHILD_ANSWER);

  const [childThread] = await childThreads(harness);
  const rows = await harness.core().read(childThread ?? '', 0);
  const started = rows.find((row) => row.event.type === 'run.started')?.event;
  expect(started?.type === 'run.started' && started.modelId).toBe(PINNED);
  // A person's follow-up in the child runs on the child's model, with its configuration.
  const selection = rows.find((row) => row.event.type === 'thread.selection.updated')?.event;
  expect(selection).toMatchObject({ configuration: { childModel: PINNED }, modelId: PINNED });
});

test('a delegation names an allowed model and effort; the tool offers exactly the allowed models', async () => {
  const { child, parent, resultCall, targets } = await delegate({
    input: { effort: 'low', model: ALLOWED },
    models: [
      { efforts: ['minimal', 'low', 'medium', 'high'], id: ALLOWED, label: 'Gemini 3.8 Flash' },
    ],
    persona: reviewer,
  });

  expect(targets).toEqual([{ effort: 'low', modelId: ALLOWED }]);
  expect(child.doStreamCalls.some((call) => userTexts(call).includes(TASK))).toBe(true);
  expect(resultText(resultCall)).toContain(CHILD_ANSWER);
  expect(offeredEnum(parent, 'model')).toEqual([ALLOWED]);
  expect(offeredEnum(parent, 'effort')).toContain('low');
});

test('without allowed models a delegation offers no model or effort, and runs on the parent’s model', async () => {
  const { child, parent, resultCall, targets } = await delegate({ persona: reviewer });

  expect(targets).toEqual([]);
  expect(child.doStreamCalls).toHaveLength(0);
  expect(resultText(resultCall)).toContain('Answer from the parent model.');
  const offered = parent.doStreamCalls[0]?.tools?.find((tool) => tool.name === 'agent-review');
  const schema = (offered?.type === 'function' ? offered.inputSchema : undefined) as
    | { properties?: Record<string, unknown> }
    | undefined;
  expect(Object.keys(schema?.properties ?? {}).sort()).toEqual(['_background', 'prompt']);
});

test('a subagent whose model cannot be admitted is refused to the parent, and no child starts', async () => {
  const { child, harness, resultCall } = await delegate({
    childConfiguration: () => {
      throw new ChildModelError('Claude Opus 5.5 (OpenRouter) takes effort low, medium, high.');
    },
    persona: {
      ...reviewer,
      model: { effort: 'none', modelId: 'anthropic/claude-opus-5.5', provider: 'openrouter' },
    },
  });

  expect(child.doStreamCalls).toHaveLength(0);
  expect(resultText(resultCall)).toContain(
    `[Delegation Rejected] Reviewer cannot run on ${PINNED}: Claude Opus 5.5 (OpenRouter) takes effort low, medium, high.`
  );
  expect(await childThreads(harness)).toEqual([]);
});

test("a nested child on another model keeps its ancestors' tool ceiling", async () => {
  // The root delegates to a worker that may only read; that worker delegates to
  // a wildcard worker pinned to another model. The pinned child is admitted on
  // the root thread's catalog, so only the ceiling keeps the reader's limits.
  const reader: AssistantPersonaDefinition = {
    allowedToolIds: ['read_file'],
    description: 'Reads, then delegates.',
    id: 'reader',
    instructions: 'You are the Reader subagent.',
    label: 'Reader',
    maxSteps: 4,
    mode: 'worker',
  };
  const pinned: AssistantPersonaDefinition = {
    allowedToolIds: ['*'],
    description: 'Works on Claude.',
    id: 'pinned',
    instructions: 'You are the Pinned subagent.',
    label: 'Pinned',
    maxSteps: 4,
    mode: 'worker',
    model: { modelId: 'anthropic/claude-opus-5.5', provider: 'openrouter' },
  };
  const parent = new MockLanguageModelV4({
    doStream: async (call) => {
      const tools = call.prompt.some((message) => message.role === 'tool');
      if (userTexts(call).some((value) => value.startsWith('READER_TASK'))) {
        return tools
          ? stream(text('Reader done.'))
          : stream(toolCall('agent-pinned', { prompt: TASK }, 'nested-delegation'));
      }
      return tools
        ? stream(text('Parent continues.'))
        : stream(
            toolCall(
              'agent-reader',
              { _background: { enabled: false }, prompt: 'READER_TASK: delegate.' },
              'reader-delegation'
            )
          );
    },
  });
  const child = childModel();
  const harness = await setupChildRunHost(parent, cleanup, {
    childConfiguration: (_configuration, target) => ({ childModel: target.modelId }),
    personas: [reader, pinned],
    resolveModel: async (modelId) => (modelId === 'scripted' ? parent : child),
  });
  const runId = await harness.start('Delegate.');
  await rowsUntil(harness, harness.threadId, finished(runId), 5000);

  const offered = child.doStreamCalls.find((call) => userTexts(call).includes(TASK));
  expect(offered).toBeDefined();
  // The reader could only read: no tool it lacked came back with the model change.
  // (A worker above the depth limit still gets the delegation tools, by depth.)
  expect(toolNames(offered as CallOptions).filter((name) => !name.startsWith('agent-'))).toEqual([
    'read_file',
  ]);
});

test('a host that cannot carry another model refuses the pin instead of running it on the parent’s', async () => {
  const parent = parentModel('agent-review', {});
  const harness = await setupChildRunHost(parent, cleanup, {
    personas: [
      { ...reviewer, model: { modelId: 'anthropic/claude-opus-5.5', provider: 'openrouter' } },
    ],
  });
  const runId = await harness.start('Delegate.');
  await rowsUntil(harness, harness.threadId, finished(runId), 5000);
  const resultCall = parent.doStreamCalls.find((call) =>
    call.prompt.some((message) => message.role === 'tool')
  );
  expect(resultText(resultCall)).toContain('runs subagents on their parent’s model only');
  expect(parent.doStreamCalls.some((call) => userTexts(call).includes(TASK))).toBe(false);
});
