import { ChildModelError } from '@brainstrike/assistant-contract/child-model';
import { findLlmModelDefinition } from '@brainstrike/assistant-contract/provider-registry';
import { Schema } from 'effect';
import { expect, test } from 'vitest';
import { desktopChildConfiguration } from '../agent-host-platform/desktop-child-configuration';
import {
  desktopInputTokenLimit,
  readDesktopIntent,
} from '../agent-host-platform/desktop-run-preconditions';
import { PlatformClientConfigurationSchema } from '../agent-host-platform/platform-client-configuration';

/** A complete desktop Send intent, as a run on OpenAI's GPT-6 Sol captures it. */
async function parentIntent(): Promise<Record<string, unknown>> {
  const definition = findLlmModelDefinition('openai', 'gpt-6-sol');
  if (!definition) {
    throw new Error('The catalog has no GPT-6 Sol');
  }
  return {
    ...(await readDesktopIntent(
      { modelId: 'openai::gpt-6-sol', signal: new AbortController().signal, threadId: 'parent' },
      { definition, model: 'gpt-6-sol', provider: 'openai' }
    )),
  };
}

test("a child's intent is its parent's with the child's model and effort in place", async () => {
  // The parent's input budget was sized for its own 1M-token window.
  const parent: Record<string, unknown> = {
    ...(await parentIntent()),
    agentLoop: { inputTokenLimit: 900_000, maxSteps: 40 },
  };
  const child = desktopChildConfiguration(parent, {
    effort: 'max',
    modelId: 'openrouter::anthropic/claude-opus-5.5',
  });

  expect(child['modelConfiguration']).toEqual({
    model: 'anthropic/claude-opus-5.5',
    // OpenRouter's output limit, sized for the model as the composer sizes it.
    modelSettings: { maxOutputTokens: expect.any(Number) },
    provider: 'openrouter',
    providerOptions: {
      openrouter: { provider: { ['require_parameters']: true }, reasoning: { effort: 'max' } },
    },
  });
  // Policy, memory, tools and subagent settings stay the parent's; its agent
  // loop does not, so admission sizes the child's input from the child's model.
  expect(child['agentLoop']).toBeUndefined();
  const opus = findLlmModelDefinition('openrouter', 'anthropic/claude-opus-5.5');
  const decoded = Schema.decodeUnknownSync(PlatformClientConfigurationSchema)(child);
  if (!opus) {
    throw new Error('The catalog has no Claude Opus 5.5 on OpenRouter');
  }
  const limit = desktopInputTokenLimit(opus, decoded, decoded.modelConfiguration);
  expect(limit).toBeLessThan(opus.contextWindow);
  expect(limit).not.toBe(900_000);
  const { modelConfiguration: _child, ...childRest } = child;
  const { agentLoop: _loop, modelConfiguration: _parent, ...parentRest } = parent;
  expect(childRest).toEqual(parentRest);
});

test('a run without a desktop intent cannot carry another model, and says so', () => {
  expect(() =>
    desktopChildConfiguration(undefined, { modelId: 'openrouter::anthropic/claude-opus-5.5' })
  ).toThrow(/no desktop settings/u);
});

test('an effort the child model does not take is refused, not dropped', async () => {
  const parent = await parentIntent();
  expect(() =>
    desktopChildConfiguration(parent, { effort: 'none', modelId: 'anthropic::claude-opus-5-5' })
  ).toThrow(ChildModelError);
});
