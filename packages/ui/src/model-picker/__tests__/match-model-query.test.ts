// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { type ModelQueryFields, matchesModelQuery } from '../utils/match-model-query';

const opus: ModelQueryFields = {
  label: 'Claude Opus 5',
  modelId: 'claude-opus-5',
  providerId: 'bedrock',
  providerName: 'Amazon Bedrock',
  tagline: 'For complex agentic coding',
};

describe('matchesModelQuery', () => {
  it.each([
    ['', true],
    ['   ', true],
    ['opus', true],
    ['OPUS', true],
    ['claude-opus-5', true],
    ['bedrock', true],
    ['amazon', true],
    ['agentic', true],
    ['opus bedrock', true],
    ['opus  amazon   coding', true],
    ['opus anthropic', false],
    ['sonnet', false],
  ])('query %j → %s', (query, expected) => {
    expect(matchesModelQuery(opus, query)).toBe(expected);
  });

  it('never matches a word across two fields', () => {
    // "5bedrock" would only match if the label and the provider id were glued together.
    expect(matchesModelQuery(opus, '5bedrock')).toBe(false);
  });

  it('treats missing optional fields as empty', () => {
    const bare: ModelQueryFields = {
      label: 'Kimi K3',
      modelId: 'moonshotai/kimi-k3',
      providerId: 'openrouter',
    };
    expect(matchesModelQuery(bare, 'moonshotai')).toBe(true);
    expect(matchesModelQuery(bare, 'agentic')).toBe(false);
  });
});

describe('matchesModelQuery keywords (BST-1805)', () => {
  const tagged: ModelQueryFields = {
    keywords: ['Coding', 'Tool use'],
    label: 'GPT-5.4',
    modelId: 'gpt-5.4',
    providerId: 'openai',
  };

  it('matches a query word against a keyword', () => {
    expect(matchesModelQuery(tagged, 'tool')).toBe(true);
  });

  it('still requires every word, keywords included', () => {
    expect(matchesModelQuery(tagged, 'coding gpt')).toBe(true);
    expect(matchesModelQuery(tagged, 'coding claude')).toBe(false);
  });

  it('never matches a word across two keywords', () => {
    expect(matchesModelQuery(tagged, 'codingtool')).toBe(false);
  });

  it('is unchanged for callers that pass no keywords', () => {
    expect(
      matchesModelQuery({ label: 'GPT-5.4', modelId: 'gpt-5.4', providerId: 'openai' }, 'tool')
    ).toBe(false);
  });
});
