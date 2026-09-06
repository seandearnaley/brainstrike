import type { McpElicitationRequestedSchemaWire } from '@brainstrike/assistant-contract';
import { describe, expect, it } from 'vitest';
import {
  buildMcpElicitationContent,
  describeMcpElicitationField,
  initialMcpElicitationFieldValues,
  readMcpElicitationFieldOptions,
} from '../mcp-elicitation-form';

const schema: McpElicitationRequestedSchemaWire = {
  properties: {
    confirm: { default: true, type: 'boolean' },
    count: { maximum: 5, minimum: 1, type: 'integer' },
    email: { format: 'email', type: 'string' },
    labels: { items: { enum: ['bug', 'chore'], type: 'string' }, maxItems: 1, type: 'array' },
    legacy: { enum: ['a', 'b'], enumNames: ['Alpha', 'Beta'], type: 'string' },
    priority: {
      oneOf: [
        { const: 'p0', title: 'Urgent' },
        { const: 'p1', title: 'High' },
      ],
      type: 'string',
    },
    ratio: { default: 0.5, type: 'number' },
    titled: {
      items: {
        anyOf: [
          { const: 'x', title: 'Ex' },
          { const: 'y', title: 'Why' },
        ],
      },
      minItems: 1,
      type: 'array',
    },
    when: { format: 'date-time', type: 'string' },
    workspace: { maxLength: 4, minLength: 2, type: 'string' },
  },
  required: ['workspace', 'titled'],
  type: 'object',
};

describe('mcp-elicitation-form', () => {
  it('classifies fields, reads options, and seeds defaults like the SDK schema', () => {
    expect(
      Object.fromEntries(
        Object.entries(schema.properties).map(([name, definition]) => [
          name,
          describeMcpElicitationField(definition),
        ])
      )
    ).toEqual({
      confirm: 'boolean',
      count: 'number',
      email: 'string',
      labels: 'multi-select',
      legacy: 'single-select',
      priority: 'single-select',
      ratio: 'number',
      titled: 'multi-select',
      when: 'string',
      workspace: 'string',
    });
    expect(
      readMcpElicitationFieldOptions(schema.properties['legacy'] ?? { type: 'boolean' })
    ).toEqual([
      { label: 'Alpha', value: 'a' },
      { label: 'Beta', value: 'b' },
    ]);
    expect(
      readMcpElicitationFieldOptions(schema.properties['titled'] ?? { type: 'boolean' })
    ).toEqual([
      { label: 'Ex', value: 'x' },
      { label: 'Why', value: 'y' },
    ]);
    expect(initialMcpElicitationFieldValues(schema)).toEqual({
      confirm: true,
      count: '',
      email: '',
      labels: [],
      legacy: '',
      priority: '',
      ratio: '0.5',
      titled: [],
      when: '',
      workspace: '',
    });
  });

  it('mirrors the host validator: required presence, formats, bounds, and allowed values', () => {
    const blank = buildMcpElicitationContent(schema, initialMcpElicitationFieldValues(schema));
    expect(blank).toEqual({
      errors: { titled: 'Choose at least 1.', workspace: 'This field is required.' },
      ok: false,
    });
    const invalid = buildMcpElicitationContent(schema, {
      count: '0',
      email: 'not-an-email',
      labels: ['bug', 'chore'],
      legacy: 'z',
      priority: 'p9',
      ratio: 'abc',
      titled: ['nope'],
      when: '2026-13-01T00:00:00Z',
      workspace: 'toolong',
    });
    expect(invalid).toEqual({
      errors: {
        count: 'Enter a value of at least 1.',
        email: 'Enter a valid email address.',
        labels: 'Choose at most 1.',
        legacy: 'Choose one of the offered values.',
        priority: 'Choose one of the offered values.',
        ratio: 'Enter a number.',
        titled: 'Choose only offered values.',
        when: 'Enter a date-time as YYYY-MM-DDTHH:MM:SSZ (or with a UTC offset).',
        workspace: 'Enter at most 4 characters.',
      },
      ok: false,
    });
    expect(
      buildMcpElicitationContent(schema, { count: '1.5', titled: ['x'], workspace: 'ok' })
    ).toEqual({
      errors: { count: 'Enter a whole number.' },
      ok: false,
    });
    const valid = buildMcpElicitationContent(schema, {
      confirm: false,
      count: '3',
      email: 'dev@example.com',
      labels: ['bug'],
      legacy: 'b',
      priority: 'p1',
      ratio: '',
      titled: ['y'],
      when: '2026-01-31T12:00:00+02:00',
      workspace: 'eng',
    });
    expect(valid).toEqual({
      content: {
        confirm: false,
        count: 3,
        email: 'dev@example.com',
        labels: ['bug'],
        legacy: 'b',
        priority: 'p1',
        titled: ['y'],
        when: '2026-01-31T12:00:00+02:00',
        workspace: 'eng',
      },
      ok: true,
    });
  });

  it('reports booleans only when defaulted, required, or explicitly changed', () => {
    const requestedSchema = {
      properties: {
        defaultedOff: { default: false, type: 'boolean' },
        optionalUntouched: { type: 'boolean' },
        requiredUntouched: { type: 'boolean' },
        toggled: { type: 'boolean' },
      },
      required: ['requiredUntouched'],
      type: 'object',
    } as const;
    const values = initialMcpElicitationFieldValues(requestedSchema);
    expect(values).toEqual({ defaultedOff: false });

    const untouched = buildMcpElicitationContent(requestedSchema, values);
    expect(untouched).toEqual({
      content: { defaultedOff: false, requiredUntouched: false },
      ok: true,
    });

    const toggled = buildMcpElicitationContent(requestedSchema, { ...values, toggled: true });
    expect(toggled).toEqual({
      content: { defaultedOff: false, requiredUntouched: false, toggled: true },
      ok: true,
    });
  });
});
