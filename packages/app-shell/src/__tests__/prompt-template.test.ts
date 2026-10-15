// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  extractPromptTemplateVariables,
  PromptTemplateMissingVariablesError,
  renderPromptTemplate,
} from '../prompt-template';

describe('prompt template helpers', () => {
  it('extracts unique variables in first-seen order and normalizes placeholder whitespace', () => {
    expect(
      extractPromptTemplateVariables(
        'Address {{  target\t audience }} in a {{ tone }} tone, then revisit {{target audience}} and {{\n output   format }}.'
      )
    ).toEqual(['target audience', 'tone', 'output format']);
  });

  it('substitutes every repeated placeholder with the exact provided value', () => {
    expect(
      renderPromptTemplate('{{ subject }} / {{subject}} / {{ exact_value }} / {{ subject }}', {
        exact_value: '$& stays exact\n{{not-recursive}}',
        subject: 'local-first systems',
      })
    ).toBe(
      'local-first systems / local-first systems / $& stays exact\n{{not-recursive}} / local-first systems'
    );
  });

  it('throws one explicit error for every missing variable before rendering', () => {
    let thrown: unknown;

    try {
      renderPromptTemplate('Hello {{ name }}. Use {{ tone }}, then {{ output format }}.', {
        name: 'Ada',
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PromptTemplateMissingVariablesError);
    expect(thrown).toMatchObject({ missingVariables: ['tone', 'output format'] });
    expect((thrown as Error).message).toBe(
      'Missing prompt template variables: tone, output format'
    );
  });

  it('leaves ordinary, JSON, and non-exact brace syntax untouched', () => {
    const source = 'JSON {"role":"user"}; math {x + y}; triple {{{not-a-variable}}}; empty {{}}.';

    expect(extractPromptTemplateVariables(source)).toEqual([]);
    expect(renderPromptTemplate(source, {})).toBe(source);
  });
});
