import { describe, expect, it } from 'vitest';
import {
  CONTEXT_BREAKDOWN_DATA_NAME,
  isAssistantContextBreakdown,
  parseAssistantContextBreakdown,
} from '../context-breakdown.js';

const validBreakdown = {
  attachmentsCount: 0,
  provenance: 'heuristic',
  systemInstructionsTokens: 1234,
} as const;

describe('context-breakdown contract', () => {
  it('pins the wire data-part name', () => {
    expect(CONTEXT_BREAKDOWN_DATA_NAME).toBe('brainstrike.context-breakdown');
  });

  it('accepts a minimal breakdown (required fields only — absent optionals are honest)', () => {
    expect(isAssistantContextBreakdown(validBreakdown)).toBe(true);
    expect(parseAssistantContextBreakdown(validBreakdown)).toEqual({
      breakdown: validBreakdown,
      invalid: false,
    });
  });

  it('accepts and forwards the optional fields when present', () => {
    const full = {
      ...validBreakdown,
      attachmentsCount: 2,
      historyMessagesTokens: 900,
      taskListTokens: 40,
    };
    expect(parseAssistantContextBreakdown(full)).toEqual({
      breakdown: full,
      invalid: false,
    });
  });

  it('keeps absent optional fields ABSENT after parsing (never zero-faked)', () => {
    const parsed = parseAssistantContextBreakdown(validBreakdown);
    if (parsed.invalid) {
      throw new Error('expected a valid parse');
    }
    expect('taskListTokens' in parsed.breakdown).toBe(false);
    expect('historyMessagesTokens' in parsed.breakdown).toBe(false);
  });

  it('tolerates unknown extra wire fields (additive evolution) without forwarding them', () => {
    const parsed = parseAssistantContextBreakdown({
      ...validBreakdown,
      futureField: 'ignored',
    });
    if (parsed.invalid) {
      throw new Error('expected a valid parse');
    }
    expect('futureField' in parsed.breakdown).toBe(false);
  });

  it('accepts and forwards the v2 tool-definition fields when present', () => {
    const withTools = {
      ...validBreakdown,
      toolDefinitionsByTool: [
        { name: 'brainstrike.readWorkspaceFile', tokens: 210 },
        { name: 'run_shell', tokens: 95 },
      ],
      toolDefinitionsProvenance: 'measured',
      toolDefinitionsTokens: 305,
    };
    expect(parseAssistantContextBreakdown(withTools)).toEqual({
      breakdown: withTools,
      invalid: false,
    });
  });

  it('rejects a whole-breakdown measured provenance (precision must never be overstated)', () => {
    expect(parseAssistantContextBreakdown({ ...validBreakdown, provenance: 'measured' })).toEqual({
      invalid: true,
    });
  });

  it('rejects a bogus toolDefinitionsProvenance', () => {
    expect(
      parseAssistantContextBreakdown({ ...validBreakdown, toolDefinitionsProvenance: 'exact' })
    ).toEqual({ invalid: true });
  });

  it('keeps absent v2 fields ABSENT after parsing (never zero-faked)', () => {
    const parsed = parseAssistantContextBreakdown(validBreakdown);
    if (parsed.invalid) {
      throw new Error('expected a valid parse');
    }
    expect('toolDefinitionsTokens' in parsed.breakdown).toBe(false);
    expect('toolDefinitionsByTool' in parsed.breakdown).toBe(false);
    expect('toolDefinitionsProvenance' in parsed.breakdown).toBe(false);
  });

  it.each([
    ['negative toolDefinitionsTokens', { ...validBreakdown, toolDefinitionsTokens: -1 }],
    ['non-array toolDefinitionsByTool', { ...validBreakdown, toolDefinitionsByTool: {} }],
    [
      'toolDefinitionsByTool entry without a name',
      { ...validBreakdown, toolDefinitionsByTool: [{ tokens: 3 }] },
    ],
    [
      'toolDefinitionsByTool entry with a bogus count',
      { ...validBreakdown, toolDefinitionsByTool: [{ name: 'x', tokens: 'lots' }] },
    ],
    [
      'toolDefinitionsByTool entry with an empty name',
      { ...validBreakdown, toolDefinitionsByTool: [{ name: '', tokens: 3 }] },
    ],
  ])('surfaces a malformed v2 payload (%s) as { invalid: true }', (_label, value) => {
    expect(parseAssistantContextBreakdown(value)).toEqual({ invalid: true });
  });

  it.each([
    ['null', null],
    ['array', [validBreakdown]],
    ['missing provenance', { ...validBreakdown, provenance: undefined }],
    ['wrong provenance', { ...validBreakdown, provenance: 'exact' }],
    [
      'missing systemInstructionsTokens',
      { ...validBreakdown, systemInstructionsTokens: undefined },
    ],
    ['negative systemInstructionsTokens', { ...validBreakdown, systemInstructionsTokens: -1 }],
    [
      'non-finite systemInstructionsTokens',
      { ...validBreakdown, systemInstructionsTokens: Number.NaN },
    ],
    ['missing attachmentsCount', { ...validBreakdown, attachmentsCount: undefined }],
    ['string attachmentsCount', { ...validBreakdown, attachmentsCount: '2' }],
    ['present-but-bogus taskListTokens', { ...validBreakdown, taskListTokens: 'lots' }],
    ['negative historyMessagesTokens', { ...validBreakdown, historyMessagesTokens: -5 }],
  ])('surfaces a malformed payload (%s) as { invalid: true }, never coerced', (_label, value) => {
    expect(parseAssistantContextBreakdown(value)).toEqual({ invalid: true });
  });
});
