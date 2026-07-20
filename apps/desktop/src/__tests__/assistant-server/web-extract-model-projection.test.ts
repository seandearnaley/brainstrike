import { MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET } from '@brainstrike/agent';
import { describe, expect, it } from 'vitest';
import {
  projectWebExtractModelOutput,
  WEB_EXTRACT_INLINE_MAX_SERIALIZED_CHARS,
} from '../../assistant-server/web-extract-model-projection';

function webExtractResult() {
  return {
    available: true,
    count: 2,
    failed: [
      {
        reason: 'page not reachable',
        url: 'https://example.com/missing?source=exact',
      },
    ],
    results: [
      {
        content: '# First\n\nUnicode 雪, emoji 😀, and `"quotes"`.',
        url: 'https://example.com/first?source=exact',
      },
      {
        content: 'Second page.',
        url: 'https://example.com/second',
      },
    ],
    truncated: false,
  };
}

describe('webExtract model projection', () => {
  it('projects complete inline source, exact URLs, and exact failure reasons', () => {
    const result = webExtractResult();
    const projection = projectWebExtractModelOutput(result);

    expect(projection).toEqual({
      type: 'text',
      value: [
        'web-extract | status=available | pages=2 | failed=1 | truncated=false',
        '#1 url: "https://example.com/first?source=exact"',
        'content_json: "# First\\n\\nUnicode 雪, emoji 😀, and `\\"quotes\\"`."',
        '#2 url: "https://example.com/second"',
        'content_json: "Second page."',
        'failed_url: "https://example.com/missing?source=exact"',
        'failed_reason: "page not reachable"',
      ].join('\n'),
    });
    expect(JSON.stringify(projection).length).toBeLessThanOrEqual(
      MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET
    );
  });

  it('keeps explicit unavailable and request-error states', () => {
    const unavailable = projectWebExtractModelOutput({
      available: false,
      count: 0,
      failed: [],
      message: 'Add a Tavily API key.',
      results: [],
      truncated: false,
    });
    const requestError = projectWebExtractModelOutput({
      available: true,
      count: 0,
      error: 'Tavily extract timed out after 15000ms.',
      failed: [],
      results: [],
      truncated: false,
    });

    expect(unavailable.value).toContain('status=unavailable');
    expect(unavailable.value).toContain('message: "Add a Tavily API key."');
    expect(requestError.value).toContain('status=error');
    expect(requestError.value).toContain('error: "Tavily extract timed out after 15000ms."');
  });

  it('fits an escape-heavy result below the stricter artifact threshold', () => {
    const raw = {
      available: true,
      count: 1,
      failed: [],
      results: [
        {
          content: '雪\\n"quoted" 😀'.repeat(100),
          url: 'https://example.com/escape-heavy',
        },
      ],
      truncated: false,
    };

    expect(JSON.stringify(raw).length).toBeLessThanOrEqual(WEB_EXTRACT_INLINE_MAX_SERIALIZED_CHARS);
    expect(JSON.stringify(projectWebExtractModelOutput(raw)).length).toBeLessThanOrEqual(
      MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET
    );
  });

  it('fails visibly if oversized or malformed output reaches the inline projector', () => {
    expect(() =>
      projectWebExtractModelOutput({
        ...webExtractResult(),
        count: 1,
        results: [{ content: 'x'.repeat(6000), url: 'https://example.com/oversized' }],
      })
    ).toThrow('webExtract output must settle before model projection');

    expect(() =>
      projectWebExtractModelOutput({
        ...webExtractResult(),
        truncated: true,
      })
    ).toThrow('webExtract model projection received a malformed result');
  });
});
