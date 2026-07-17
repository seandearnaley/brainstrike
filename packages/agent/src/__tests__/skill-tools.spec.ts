/**
 * Assistant skill tools tests.
 *
 * `createAssistantSkillTools` wraps Mastra's canonical `createSkillTools`
 * (`skill` / `skill_search` / `skill_read`) with brainstrike's tool-output
 * contract: every result self-bounds with an HONEST truncation note (never a
 * hard size error), and the `skill` activation tool gets a dedicated, larger
 * budget — the Agent Skills spec allows ~5k-token instructions, above the
 * generic 3000-token transport guard. The transport backstop
 * (`boundToolOutputForModel`) honors the same per-tool override so a full-size
 * skill activation is never converted into a `tool_result_too_large` error.
 */

import { createSkill, resolveAgentSkills } from '@mastra/core/skills';
import { describe, expect, it } from 'vitest';
import {
  createAssistantSkillTools,
  SKILL_ACTIVATION_RESULT_TOKEN_BUDGET,
  SKILL_TOOL_IDS,
} from '../skills/skill-tools';
import { boundToolOutputForModel, MAX_TOOL_RESULT_TOKENS } from '../stream/tool-output-limits';

function inlineEngine(instructions: string, extra: Parameters<typeof createSkill>[0][] = []) {
  return resolveAgentSkills([
    createSkill({
      description: 'Test skill for activation.',
      instructions,
      name: 'test-skill',
      references: { 'notes.md': 'Reference notes content.' },
    }),
    ...extra.map((input) => createSkill(input)),
  ]);
}

async function executeTool(tool: unknown, input: unknown): Promise<unknown> {
  const execute = (tool as { execute: (input: unknown, context: unknown) => Promise<unknown> })
    .execute;
  return await execute(input, {});
}

describe('createAssistantSkillTools', () => {
  it('returns the three canonical Mastra skill tools', () => {
    const tools = createAssistantSkillTools(inlineEngine('Short instructions.'));
    expect(Object.keys(tools).sort()).toEqual([...SKILL_TOOL_IDS].sort());
    expect(SKILL_TOOL_IDS).toEqual(['skill', 'skill_read', 'skill_search']);
  });

  it('activates a skill and returns its instructions plus reference listing verbatim when small', async () => {
    const tools = createAssistantSkillTools(inlineEngine('Do the thing carefully.'));
    const output = await executeTool(tools.skill, { name: 'test-skill' });
    expect(String(output)).toContain('Do the thing carefully.');
    expect(String(output)).toContain('references/notes.md');
  });

  it('self-bounds an oversized activation with an honest truncation note (never an error)', async () => {
    // Markdown with newlines: JSON serialization escapes them, so the bound
    // must hold on the SERIALIZED form the transport guard measures — a
    // raw-length bound would still trip tool_result_too_large downstream.
    const hugeInstructions = 'word line\n'.repeat(20_000);
    const tools = createAssistantSkillTools(inlineEngine(hugeInstructions));
    const output = String(await executeTool(tools.skill, { name: 'test-skill' }));
    expect(JSON.stringify(output).length).toBeLessThanOrEqual(
      SKILL_ACTIVATION_RESULT_TOKEN_BUDGET * 4
    );
    expect(output).toMatch(/truncated/i);
    // The backstop must accept the self-bounded result verbatim.
    expect(boundToolOutputForModel('skill', output).errorText).toBeUndefined();
  });

  it('reports an unknown skill with the available list (Mastra message, passed through)', async () => {
    const tools = createAssistantSkillTools(inlineEngine('Short.'));
    const output = String(await executeTool(tools.skill, { name: 'missing' }));
    expect(output).toMatch(/not found/i);
    expect(output).toContain('test-skill');
  });

  it('bounds skill_read output with an honest note and a line-range hint', async () => {
    const bigReference = Array.from({ length: 30_000 }, (_, i) => `ref line ${i}`).join('\n');
    const tools = createAssistantSkillTools(
      inlineEngine('Short.', [
        {
          description: 'Skill with a big reference.',
          instructions: 'See references/big.md.',
          name: 'big-ref',
          references: { 'big.md': bigReference },
        },
      ])
    );
    const output = String(
      await executeTool(tools.skill_read, { path: 'references/big.md', skillName: 'big-ref' })
    );
    expect(output.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_TOKENS * 4);
    expect(output).toMatch(/truncated/i);
    expect(output).toMatch(/startLine|endLine/);
  });
});

describe('transport guard override for skill activations', () => {
  it('passes a full-size skill activation (over the generic budget, under the skill budget)', () => {
    const activation = 'a'.repeat(MAX_TOOL_RESULT_TOKENS * 4 + 1000);
    const bounded = boundToolOutputForModel('skill', activation);
    expect(bounded.errorText).toBeUndefined();
    expect(bounded.output).toBe(activation);
  });

  it('still backstops a skill output beyond the skill budget', () => {
    const activation = 'a'.repeat(SKILL_ACTIVATION_RESULT_TOKEN_BUDGET * 4 + 4000);
    const bounded = boundToolOutputForModel('skill', activation);
    expect(bounded.errorText).toBeDefined();
  });

  it('keeps the generic budget for every other tool', () => {
    const oversized = 'a'.repeat(MAX_TOOL_RESULT_TOKENS * 4 + 1000);
    const bounded = boundToolOutputForModel('someOtherTool', oversized);
    expect(bounded.errorText).toBeDefined();
  });
});
