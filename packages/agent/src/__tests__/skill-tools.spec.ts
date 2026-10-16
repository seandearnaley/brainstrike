/**
 * Assistant skill tools tests.
 *
 * `createAssistantSkillTools` wraps Mastra's canonical `createSkillTools`
 * (`skill` / `skill_search` / `skill_read`) with brainstrike's tool-output
 * contract: every result self-bounds with an HONEST truncation note (never a
 * hard size error), and the `skill` activation tool gets a dedicated, larger
 * budget — the Agent Skills spec allows ~5k-token instructions, above the
 * generic 2000-token model projection / 3000-token transport guard. The shared
 * backstop (`boundToolOutputForModel`) honors the same override so a full-size
 * skill activation is never prematurely truncated.
 */

import { createSkill, resolveAgentSkills } from '@mastra/core/skills';
import { describe, expect, it } from 'vitest';
import {
  BRAINSTRIKE_SKILL_EXECUTION_GUIDANCE,
  createAssistantSkillTools,
  SKILL_ACTIVATION_RESULT_TOKEN_BUDGET,
  SKILL_TOOL_IDS,
} from '../skills/skill-tools';
import {
  boundToolOutputForModel,
  MAX_TOOL_RESULT_TOKENS,
  TOOL_RESULT_TRUNCATED_CODE,
} from '../stream/tool-output-limits';

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

  it('routes bundled scripts and project writes through typed native tools', async () => {
    const tools = createAssistantSkillTools(inlineEngine('Run scripts/palette.mjs if useful.'));
    const output = String(await executeTool(tools.skill, { name: 'test-skill' }));

    expect(output).toContain('brainstrike_runSkillScript');
    expect(output).toContain('brainstrike_writeWorkspaceFile');
    expect(output).toMatch(/declined.*continue.*native workspace tools/is);
    expect(output).not.toMatch(/absolute skill path/i);
  });

  it('self-bounds an oversized activation with an honest truncation note (never an error)', async () => {
    // Markdown with newlines: JSON serialization escapes them, so the bound
    // must hold on the SERIALIZED form the transport guard measures — a
    // raw-length bound would still force a second downstream truncation.
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

  it('returns a successful preview for a skill output beyond the skill budget', () => {
    const activation = 'a'.repeat(SKILL_ACTIVATION_RESULT_TOKEN_BUDGET * 4 + 4000);
    const bounded = boundToolOutputForModel('skill', activation);
    expect(bounded.errorText).toBeUndefined();
    expect(bounded.output).toMatchObject({
      code: TOOL_RESULT_TRUNCATED_CODE,
      maxTokens: SKILL_ACTIVATION_RESULT_TOKEN_BUDGET,
      truncated: true,
    });
  });

  it('keeps the generic budget for every other tool', () => {
    const oversized = 'a'.repeat(MAX_TOOL_RESULT_TOKENS * 4 + 1000);
    const bounded = boundToolOutputForModel('someOtherTool', oversized);
    expect(bounded.errorText).toBeUndefined();
    expect(bounded.output).toMatchObject({
      code: TOOL_RESULT_TRUNCATED_CODE,
      maxTokens: MAX_TOOL_RESULT_TOKENS,
      truncated: true,
    });
  });
});

describe('activation execution guidance', () => {
  // Field failure (2026-08-23): a skill activation told the model to "run
  // listed skill scripts with brainstrike.runSkillScript", but that tool is
  // DEFERRED behind tool discovery on hosted discovery runs. The model checked
  // its visible tools, concluded the tool did not exist, and worked around via
  // executeCommand — bypassing the typed skill-script policy layer. The
  // guidance must carry its own recovery path: load the tool via load_tool by
  // exact name first, callable on the next step of the same response. (On non-discovery runs the tool is eager and
  // the clause is inert.)
  it('tells the model how to LOAD runSkillScript when it is deferred', async () => {
    const { BRAINSTRIKE_SKILL_EXECUTION_GUIDANCE } = await import('../skills/skill-tools');
    expect(BRAINSTRIKE_SKILL_EXECUTION_GUIDANCE).toContain('load_tool');
    expect(BRAINSTRIKE_SKILL_EXECUTION_GUIDANCE).not.toContain('search_tools');
    // load_tool matches the REGISTERED (sanitized) id exactly; the dotted
    // canonical id would return "not found" (review of #3049).
    expect(BRAINSTRIKE_SKILL_EXECUTION_GUIDANCE).toContain('brainstrike_runSkillScript');
    expect(BRAINSTRIKE_SKILL_EXECUTION_GUIDANCE).toContain('brainstrike_writeWorkspaceFile');
    expect(BRAINSTRIKE_SKILL_EXECUTION_GUIDANCE).not.toContain('brainstrike.runSkillScript');
    expect(BRAINSTRIKE_SKILL_EXECUTION_GUIDANCE).toContain('same response');
    expect(BRAINSTRIKE_SKILL_EXECUTION_GUIDANCE).not.toContain('next turn');
  });

  // Live smoke 2026-10-16: on plain canvas requests GLM, Qwen and Grok
  // activated a broadly described design skill and then asked to run its
  // script, because this guidance (appended to EVERY activation) read as an
  // instruction to run one. A script runs only when the skill's instructions
  // call for it in the user's task.
  it('asks for a skill script only when the skill’s instructions call for it in the task', async () => {
    const { BRAINSTRIKE_SKILL_EXECUTION_GUIDANCE } = await import('../skills/skill-tools');
    expect(BRAINSTRIKE_SKILL_EXECUTION_GUIDANCE).toMatch(
      /only when these instructions call for (?:it|one) in the user's task/
    );
  });
});

describe('activation guidance survives truncation', () => {
  // Review of #2625: the wrappers nested as
  // withBoundedStringOutput(withActivationGuidance(...)), so the guidance was
  // appended BEFORE bounding — and fitToSerializedBudget keeps a PREFIX, so an
  // activation exceeding the budget lost the entire trailing guidance block.
  // That is precisely the large, script-heavy SKILL.md most likely to need the
  // runSkillScript recovery path (the 2026-08-23 field failure's shape). The
  // bound must reserve the guidance's space: truncated content + honest note +
  // guidance, all inside the budget — the same order the desktop activation
  // context uses.
  it('keeps the execution guidance on an over-budget activation', async () => {
    const hugeInstructions = 'run scripts/setup.mjs then scripts/build.mjs. '.repeat(2000);
    const tools = createAssistantSkillTools(inlineEngine(hugeInstructions));
    const output = String(await executeTool(tools.skill, { name: 'test-skill' }));

    expect(output).toContain('[Skill instructions truncated');
    expect(output.endsWith(BRAINSTRIKE_SKILL_EXECUTION_GUIDANCE)).toBe(true);
    // Still inside the transport budget the bound exists to satisfy.
    expect(JSON.stringify(output).length).toBeLessThanOrEqual(
      SKILL_ACTIVATION_RESULT_TOKEN_BUDGET * 4
    );
  });

  it('appends the guidance verbatim on an under-budget activation', async () => {
    const tools = createAssistantSkillTools(inlineEngine('Short instructions.'));
    const output = String(await executeTool(tools.skill, { name: 'test-skill' }));
    expect(output.endsWith(BRAINSTRIKE_SKILL_EXECUTION_GUIDANCE)).toBe(true);
  });
});
