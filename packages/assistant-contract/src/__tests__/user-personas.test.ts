/**
 * User-defined persona contract: frontmatter parsing, id derivation, and
 * validation into an AssistantPersonaDefinition. Mirrors the fail-closed
 * posture of user-slash-commands.test.ts: malformed input never half-parses,
 * non-read tools never pass validation, and every failure carries a
 * human-readable error (surfaced in the personas settings panel).
 */

import { describe, expect, it } from 'vitest';
import { type AssistantPersonaDefinition, BUILT_IN_PERSONAS } from '../personas.js';
import {
  buildUserPersona,
  DEFAULT_USER_PERSONA_MAX_STEPS,
  DEFAULT_USER_PERSONA_TOOL_IDS,
  deriveUserPersonaId,
  MAX_USER_PERSONA_FILE_CHARS,
  MAX_USER_PERSONA_MAX_STEPS,
  MAX_USER_PERSONAS,
  parsePersonaModelPin,
  parseUserPersonaFile,
} from '../user-personas.js';

const VALID_BODY = 'You are a security auditor. Read code and report risks.';

function validFile(frontmatter: string): string {
  return `---\n${frontmatter}\n---\n${VALID_BODY}`;
}

describe('parseUserPersonaFile', () => {
  it('parses name, description, inline tools, model, and maxSteps', () => {
    const parsed = parseUserPersonaFile(
      validFile(
        [
          'name: Security Auditor',
          'description: Audits workspace code for security issues',
          'tools: readWorkspaceFile, grepSearch',
          'model: anthropic::claude-haiku-4-5',
          'maxSteps: 6',
        ].join('\n')
      )
    );
    expect(parsed).toEqual({
      description: 'Audits workspace code for security issues',
      instructions: VALID_BODY,
      maxSteps: 6,
      model: 'anthropic::claude-haiku-4-5',
      name: 'Security Auditor',
      ok: true,
      tools: ['readWorkspaceFile', 'grepSearch'],
    });
  });

  it('parses a YAML list under tools:', () => {
    const parsed = parseUserPersonaFile(
      validFile(['description: d', 'tools:', '  - readWorkspaceFile', '  - grepSearch'].join('\n'))
    );
    expect(parsed).toMatchObject({
      ok: true,
      tools: ['readWorkspaceFile', 'grepSearch'],
    });
  });

  it('a file without frontmatter fails closed (personas require description)', () => {
    const parsed = parseUserPersonaFile('just a body, no frontmatter');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toMatch(/frontmatter/i);
    }
  });

  it('unterminated frontmatter fails closed', () => {
    const parsed = parseUserPersonaFile('---\ndescription: d\nno closing fence');
    expect(parsed).toMatchObject({ ok: false });
  });

  it('a malformed key line fails closed (no silent half-parse)', () => {
    const parsed = parseUserPersonaFile(validFile('description: d\nnot a key value line'));
    expect(parsed).toMatchObject({ ok: false });
  });

  it('a list item outside a recognized list key fails closed', () => {
    const parsed = parseUserPersonaFile(validFile('description: d\n- stray item'));
    expect(parsed).toMatchObject({ ok: false });
  });

  it('ignores unknown scalar keys (forward compatibility)', () => {
    const parsed = parseUserPersonaFile(validFile('description: d\ncolor: purple'));
    expect(parsed).toMatchObject({ description: 'd', ok: true });
  });

  it('non-integer maxSteps fails closed', () => {
    const parsed = parseUserPersonaFile(validFile('description: d\nmaxSteps: soon'));
    expect(parsed).toMatchObject({ ok: false });
  });

  it('strips a UTF-8 BOM before fence detection', () => {
    const parsed = parseUserPersonaFile(`﻿${validFile('description: d')}`);
    expect(parsed).toMatchObject({ description: 'd', ok: true });
  });
});

describe('deriveUserPersonaId', () => {
  it('derives the id from the file name', () => {
    expect(deriveUserPersonaId('security-auditor.md')).toEqual({
      id: 'security-auditor',
      ok: true,
    });
  });

  it('rejects ids that are not delegation-tool-name safe', () => {
    // The id becomes the `agent-<id>` tool name; provider tool-name charsets
    // (Anthropic/OpenAI) forbid ':' and spaces, so these must fail closed.
    for (const fileName of ['sec:audit.md', 'my persona.md', 'ün.md', '.md']) {
      expect(deriveUserPersonaId(fileName)).toMatchObject({ ok: false });
    }
  });

  it('accepts letters, digits, underscore, and hyphen', () => {
    expect(deriveUserPersonaId('Sec_Audit-2.md')).toEqual({ id: 'Sec_Audit-2', ok: true });
  });
});

describe('parsePersonaModelPin', () => {
  it('parses provider::modelId', () => {
    expect(parsePersonaModelPin('anthropic::claude-haiku-4-5')).toEqual({
      ok: true,
      pin: { modelId: 'claude-haiku-4-5', provider: 'anthropic' },
    });
  });

  it('keeps :: inside the model id intact after the first separator', () => {
    expect(parsePersonaModelPin('openrouter::meta-llama/llama-3.3-70b')).toEqual({
      ok: true,
      pin: { modelId: 'meta-llama/llama-3.3-70b', provider: 'openrouter' },
    });
  });

  it('rejects values without the :: separator (no format guessing)', () => {
    expect(parsePersonaModelPin('anthropic/claude-haiku-4-5')).toMatchObject({ ok: false });
    expect(parsePersonaModelPin('claude-haiku-4-5')).toMatchObject({ ok: false });
  });

  it('rejects empty provider or model id', () => {
    expect(parsePersonaModelPin('::model')).toMatchObject({ ok: false });
    expect(parsePersonaModelPin('anthropic::')).toMatchObject({ ok: false });
  });
});

describe('buildUserPersona', () => {
  it('builds a read-only persona with defaults applied', () => {
    const result = buildUserPersona({
      content: validFile('description: Security review specialist'),
      fileName: 'security-auditor.md',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const persona: AssistantPersonaDefinition = result.persona;
    expect(persona.id).toBe('security-auditor');
    expect(persona.label).toBe('security-auditor');
    expect(persona.description).toBe('Security review specialist');
    expect(persona.instructions).toBe(VALID_BODY);
    expect(persona.maxSteps).toBe(DEFAULT_USER_PERSONA_MAX_STEPS);
    expect(persona.allowedToolIds).toEqual(DEFAULT_USER_PERSONA_TOOL_IDS);
    expect(persona.model).toBeUndefined();
    expect(persona.source).toBe('user');
  });

  it('uses frontmatter name as the label and normalizes bare tool names', () => {
    const result = buildUserPersona({
      content: validFile(
        [
          'name: Security Auditor',
          'description: d',
          'tools: readWorkspaceFile, brainstrike.grepSearch',
        ].join('\n')
      ),
      fileName: 'security-auditor.md',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.persona.label).toBe('Security Auditor');
    expect(result.persona.allowedToolIds).toEqual([
      'brainstrike.readWorkspaceFile',
      'brainstrike.grepSearch',
    ]);
  });

  it('rejects a persona naming a non-read tool (read-only invariant)', () => {
    const result = buildUserPersona({
      content: validFile('description: d\ntools: writeWorkspaceFile'),
      fileName: 'p.md',
    });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.error).toMatch(/read-only|read risk|not 'read'/i);
    }
  });

  it('rejects a persona naming an unknown tool (unknown is not read)', () => {
    const result = buildUserPersona({
      content: validFile('description: d\ntools: Bash'),
      fileName: 'p.md',
    });
    expect(result).toMatchObject({ ok: false });
  });

  it('rejects a missing description', () => {
    const result = buildUserPersona({
      content: validFile('name: n'),
      fileName: 'p.md',
    });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.error).toMatch(/description/i);
    }
  });

  it('rejects an empty instructions body', () => {
    const result = buildUserPersona({
      content: '---\ndescription: d\n---\n   \n',
      fileName: 'p.md',
    });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.error).toMatch(/instructions|body/i);
    }
  });

  it('rejects an id colliding with a built-in persona', () => {
    for (const builtIn of BUILT_IN_PERSONAS) {
      const result = buildUserPersona({
        content: validFile('description: d'),
        fileName: `${builtIn.id}.md`,
      });
      expect(result).toMatchObject({ ok: false });
      if (!result.ok) {
        expect(result.error).toMatch(/built-in/i);
      }
    }
  });

  it('clamps nothing silently: out-of-range maxSteps is an error, not a clamp', () => {
    const over = buildUserPersona({
      content: validFile(`description: d\nmaxSteps: ${MAX_USER_PERSONA_MAX_STEPS + 1}`),
      fileName: 'p.md',
    });
    expect(over).toMatchObject({ ok: false });
    const zero = buildUserPersona({
      content: validFile('description: d\nmaxSteps: 0'),
      fileName: 'p.md',
    });
    expect(zero).toMatchObject({ ok: false });
  });

  it('accepts a model pin for a known provider and rejects unknown providers', () => {
    const pinned = buildUserPersona({
      content: validFile('description: d\nmodel: anthropic::claude-haiku-4-5'),
      fileName: 'p.md',
    });
    expect(pinned.ok).toBe(true);
    if (pinned.ok) {
      expect(pinned.persona.model).toEqual({
        modelId: 'claude-haiku-4-5',
        provider: 'anthropic',
      });
    }
    const unknown = buildUserPersona({
      content: validFile('description: d\nmodel: notaprovider::m'),
      fileName: 'p.md',
    });
    expect(unknown).toMatchObject({ ok: false });
    if (!unknown.ok) {
      expect(unknown.error).toMatch(/provider/i);
    }
  });

  it('oversized file content fails closed against the char cap', () => {
    const filler = 'x'.repeat(MAX_USER_PERSONA_FILE_CHARS + 1);
    const result = buildUserPersona({
      content: `---\ndescription: d\n---\n${filler}`,
      fileName: 'p.md',
    });
    expect(result).toMatchObject({ ok: false });
  });

  it('exposes sane scan caps', () => {
    expect(MAX_USER_PERSONAS).toBeGreaterThan(0);
    expect(MAX_USER_PERSONA_MAX_STEPS).toBeGreaterThanOrEqual(DEFAULT_USER_PERSONA_MAX_STEPS);
  });
});
