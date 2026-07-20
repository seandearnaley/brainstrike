import { MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET } from '@brainstrike/agent';
import { describe, expect, it } from 'vitest';
import { projectWebSearchModelOutput } from '../../assistant-server/web-search-model-projection';

function serializedChars(value: unknown): number {
  return JSON.stringify(value).length;
}

function webSearchResult() {
  return {
    available: true,
    count: 2,
    query: 'current Mastra tool output docs',
    results: [
      {
        snippet: 'Mastra tools can define a model-facing output projection.',
        title: 'Mastra tool documentation',
        url: 'https://mastra.ai/docs/agents/using-tools',
      },
      {
        snippet: 'The callback receives the raw execute result.',
        title: 'Mastra createTool reference',
        url: 'https://mastra.ai/reference/tools/create-tool',
      },
    ],
    totalResults: 2,
    truncated: false,
  };
}

describe('webSearch model projection', () => {
  it('projects ranked citations with exact URLs and bounded evidence', () => {
    expect(projectWebSearchModelOutput(webSearchResult())).toEqual({
      type: 'text',
      value: [
        'web-search | status=available | shown=2/2 | truncated=false',
        'query: "current Mastra tool output docs"',
        '#1 title: Mastra tool documentation',
        'url: "https://mastra.ai/docs/agents/using-tools"',
        'snippet: Mastra tools can define a model-facing output projection.',
        '#2 title: Mastra createTool reference',
        'url: "https://mastra.ai/reference/tools/create-tool"',
        'snippet: The callback receives the raw execute result.',
      ].join('\n'),
    });
  });

  it('materially reduces a producer-valid maximum result and self-fits the domain budget', () => {
    const raw = {
      ...webSearchResult(),
      count: 10,
      query: 'q'.repeat(800),
      results: Array.from({ length: 10 }, (_, index) => ({
        snippet: `snippet ${index} ${'S'.repeat(400)}`,
        title: `result ${index} ${'T'.repeat(250)}`,
        url: `https://example.com/${index}/${'u'.repeat(100)}`,
      })),
      totalResults: 10,
    };

    const projected = projectWebSearchModelOutput(raw);

    expect(serializedChars(raw)).toBeGreaterThan(MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET);
    expect(serializedChars(raw)).toBeLessThanOrEqual(2750 * 4);
    expect(serializedChars(projected)).toBeLessThanOrEqual(
      MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET
    );
    expect(serializedChars(projected)).toBeLessThan(serializedChars(raw) * 0.75);
    expect(projected.value).toContain('projection_omitted_results=');
    expect(projected.value).toContain('refine: reuse brainstrike.webSearch with a narrower query');
  });

  it('keeps unavailable, request-error, and empty-hit states explicit', () => {
    const unavailable = projectWebSearchModelOutput({
      available: false,
      count: 0,
      message: 'Add a Tavily API key.',
      query: 'latest docs',
      results: [],
      totalResults: 0,
      truncated: false,
    });
    const requestError = projectWebSearchModelOutput({
      available: true,
      count: 0,
      error: 'Tavily search timed out after 10000ms.',
      query: 'latest docs',
      results: [],
      totalResults: 0,
      truncated: false,
    });
    const empty = projectWebSearchModelOutput({
      available: true,
      count: 0,
      query: 'latest docs',
      results: [],
      totalResults: 0,
      truncated: false,
    });

    expect(unavailable.value).toContain('status=unavailable');
    expect(unavailable.value).toContain('message: Add a Tavily API key.');
    expect(requestError.value).toContain('status=error');
    expect(requestError.value).toContain('error: Tavily search timed out after 10000ms.');
    expect(empty.value).toContain('status=available | shown=0/0');
  });

  it('never clips a citation URL and retains producer truncation guidance', () => {
    const exactUrl = `https://example.com/${'segment/'.repeat(300)}citation`;
    const raw = {
      ...webSearchResult(),
      count: 1,
      hint: 'Showing 1 of 2 results. Refine the query.',
      results: [
        {
          snippet: 'A'.repeat(601),
          title: 'Long citation',
          url: exactUrl,
        },
      ],
      totalResults: 2,
      truncated: true,
    };
    const snapshot = structuredClone(raw);

    const projected = projectWebSearchModelOutput(raw);

    expect(projected.value).toContain(`url: ${JSON.stringify(exactUrl)}`);
    expect(projected.value).toContain(`hint: ${raw.hint}`);
    expect(projected.value).not.toContain('URL chars omitted');
    expect(raw).toEqual(snapshot);
  });

  it('bounds escape-heavy queries without losing explicit omission state', () => {
    const projected = projectWebSearchModelOutput({
      available: true,
      count: 0,
      query: '\u0000'.repeat(1600),
      results: [],
      totalResults: 0,
      truncated: false,
    });

    expect(serializedChars(projected)).toBeLessThanOrEqual(
      MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET
    );
    expect(projected.value).toContain('query chars omitted');
  });

  it('throws visibly for malformed URLs and unguided truncated results', () => {
    expect(() =>
      projectWebSearchModelOutput({
        ...webSearchResult(),
        results: [{ snippet: 'evidence', title: 'Result', url: 42 }],
      })
    ).toThrow('webSearch model projection received a malformed result');

    expect(() =>
      projectWebSearchModelOutput({
        ...webSearchResult(),
        results: [{ snippet: 'evidence', title: 'Result', url: 'not-a-citation-url' }],
      })
    ).toThrow('webSearch model projection received a malformed result');

    expect(() =>
      projectWebSearchModelOutput({
        ...webSearchResult(),
        count: 1,
        results: webSearchResult().results.slice(0, 1),
        totalResults: 2,
        truncated: true,
      })
    ).toThrow('webSearch model projection received a malformed result');
  });
});
