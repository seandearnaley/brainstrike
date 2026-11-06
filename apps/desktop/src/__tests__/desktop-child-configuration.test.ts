import { ChildModelError } from '@brainstrike/assistant-contract/child-model';
import { findLlmModelDefinition } from '@brainstrike/assistant-contract/provider-registry';
import { expect, test } from 'vitest';
import { desktopChildConfiguration } from '../agent-host-platform/desktop-child-configuration';
import { readDesktopIntent } from '../agent-host-platform/desktop-run-preconditions';

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
  const parent = await parentIntent();
  const child = desktopChildConfiguration(parent, {
    effort: 'max',
    modelId: 'openrouter::anthropic/claude-opus-5.5',
  });

  expect(child['modelConfiguration']).toEqual({
    model: 'anthropic/claude-opus-5.5',
    provider: 'openrouter',
    providerOptions: {
      openrouter: { provider: { ['require_parameters']: true }, reasoning: { effort: 'max' } },
    },
  });
  // Policy, memory, tools and subagent settings stay the parent's.
  const { modelConfiguration: _child, ...childRest } = child;
  const { modelConfiguration: _parent, ...parentRest } = parent;
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
