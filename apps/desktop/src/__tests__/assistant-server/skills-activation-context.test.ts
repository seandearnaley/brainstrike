/**
 * Explicit skill activation (`:skill[name]` directives) tests.
 *
 * The composer's "/" menu stages a visible `:skill[name]` directive; at the
 * request boundary the server resolves each directive against the per-request
 * skills engine and PREPENDS one `system` context message carrying the
 * activations (Mastra's `formatSkillActivation` payload — identical to what
 * the model-initiated `skill` tool returns). Mirrors the `@file` referenced-
 * files injector: only the LAST user message is scanned, unresolvable
 * activations surface an explicit note (never silent), and both per-skill and
 * aggregate budgets truncate/omit HONESTLY.
 */

import type { AgentMessage } from '@brainstrike/agent';
import {
  createScannedWorkspaceSkills,
  type SkillContentDeps,
  type SkillScanDeps,
  scanSkills,
} from '@brainstrike/agent';
import { MAX_ACTIVATED_SKILLS_PER_MESSAGE } from '@brainstrike/assistant-contract';
import { describe, expect, it } from 'vitest';
import {
  injectActivatedSkillsContext,
  MAX_SKILL_ACTIVATION_CHARS_PER_SKILL,
  MAX_SKILL_ACTIVATION_TOTAL_CHARS,
} from '../../assistant-server/skills-activation-context';

interface MemoryFs {
  dirs: Record<string, readonly { name: string; kind: 'file' | 'dir' }[]>;
  files: Record<string, string>;
}

function makeScanDeps(fs: MemoryFs): SkillScanDeps {
  return {
    listDir: (absDir, _containmentRoot, maxEntries) => {
      const entries = fs.dirs[absDir];
      if (!entries) {
        return null;
      }
      return {
        entries: entries.slice(0, maxEntries).map((entry) => ({
          isDirectory: entry.kind === 'dir',
          isFile: entry.kind === 'file',
          name: entry.name,
        })),
        inspected: Math.min(entries.length, maxEntries),
        truncated: entries.length > maxEntries,
      };
    },
    readFile: (absFile) =>
      absFile in fs.files
        ? { content: fs.files[absFile] as string, ok: true }
        : { ok: false, reason: 'unreadable' },
  };
}

const SKILLS_DIR = '/proj/a/.brainstrike/skills';

function skillFixture(name: string, instructions: string): MemoryFs {
  return {
    dirs: {
      [SKILLS_DIR]: [{ kind: 'dir', name }],
      [`${SKILLS_DIR}/${name}`]: [{ kind: 'file', name: 'SKILL.md' }],
    },
    files: {
      [`${SKILLS_DIR}/${name}/SKILL.md`]: `---\nname: ${name}\ndescription: Test skill ${name}.\n---\n${instructions}`,
    },
  };
}

function mergeFs(...fss: MemoryFs[]): MemoryFs {
  const merged: MemoryFs = { dirs: {}, files: {} };
  for (const fs of fss) {
    for (const [dir, entries] of Object.entries(fs.dirs)) {
      merged.dirs[dir] = [...(merged.dirs[dir] ?? []), ...entries];
    }
    Object.assign(merged.files, fs.files);
  }
  return merged;
}

function makeEngine(fs: MemoryFs) {
  const scanDeps = makeScanDeps(fs);
  const contentDeps: SkillContentDeps = {
    listDir: scanDeps.listDir,
    readFileBytes: () => ({ ok: false, reason: 'unreadable' }),
    readFileText: scanDeps.readFile,
  };
  return createScannedWorkspaceSkills({
    deps: contentDeps,
    scan: () =>
      scanSkills(
        { homeDir: '/home/user', roots: [{ absPath: '/proj/a', displayName: 'A', id: 'root-a' }] },
        scanDeps
      ),
  });
}

function userMessage(text: string): AgentMessage {
  return { id: 'u1', parts: [{ text, type: 'text' }], role: 'user' };
}

function systemTextOf(messages: readonly AgentMessage[]): string {
  const first = messages[0];
  if (first?.role !== 'system') {
    return '';
  }
  return first.parts.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

describe('injectActivatedSkillsContext', () => {
  it('returns the same array when the message has no skill directives', async () => {
    const engine = makeEngine(skillFixture('alpha', 'Alpha instructions.'));
    const messages = [userMessage('no directives here')];
    const result = await injectActivatedSkillsContext(messages, engine);
    expect(result).toBe(messages);
  });

  it('prepends one system message with the activated skill instructions', async () => {
    const engine = makeEngine(skillFixture('alpha', 'Alpha instructions body.'));
    const messages = [userMessage('please :skill[alpha] do the thing')];
    const result = await injectActivatedSkillsContext(messages, engine);
    expect(result).toHaveLength(2);
    const text = systemTextOf(result);
    expect(text).toContain('alpha');
    expect(text).toContain('Alpha instructions body.');
    expect(result[1]).toBe(messages[0]);
  });

  it('activates multiple skills and surfaces an unknown skill with an explicit note', async () => {
    const engine = makeEngine(
      mergeFs(skillFixture('alpha', 'Alpha body.'), skillFixture('beta', 'Beta body.'))
    );
    const messages = [userMessage(':skill[alpha] :skill[ghost] :skill[beta]')];
    const result = await injectActivatedSkillsContext(messages, engine);
    const text = systemTextOf(result);
    expect(text).toContain('Alpha body.');
    expect(text).toContain('Beta body.');
    expect(text).toMatch(/ghost.*not available|not available.*ghost/i);
  });

  it('scans only the LAST user message', async () => {
    const engine = makeEngine(skillFixture('alpha', 'Alpha body.'));
    const messages = [
      userMessage(':skill[alpha] earlier turn'),
      { id: 'a1', parts: [{ text: 'sure', type: 'text' }], role: 'assistant' } as AgentMessage,
      userMessage('nothing this turn'),
    ];
    const result = await injectActivatedSkillsContext(messages, engine);
    expect(result).toBe(messages);
  });

  it('does nothing when no engine is attached (skills disabled ⇒ directives stay inert)', async () => {
    const messages = [userMessage(':skill[alpha]')];
    const result = await injectActivatedSkillsContext(messages, undefined);
    expect(result).toBe(messages);
  });

  it('truncates an oversized activation honestly at the per-skill budget', async () => {
    // 40K chars: under the 64K SKILL.md scan cap (still a valid skill), over
    // the 24K per-activation budget (must truncate honestly).
    const engine = makeEngine(skillFixture('huge', 'word '.repeat(8000)));
    const messages = [userMessage(':skill[huge]')];
    const result = await injectActivatedSkillsContext(messages, engine);
    const text = systemTextOf(result);
    expect(text.length).toBeLessThanOrEqual(MAX_SKILL_ACTIVATION_CHARS_PER_SKILL + 2000);
    expect(text).toMatch(/truncated/i);
  });

  it('enforces the aggregate budget as a HARD ceiling with an honest omission note', async () => {
    // Three ~20K-char skills: two fit under the 48K aggregate, the third must
    // be OMITTED (named in the note) — never crammed past the ceiling.
    const big = 'word '.repeat(4000);
    const engine = makeEngine(
      mergeFs(skillFixture('big-a', big), skillFixture('big-b', big), skillFixture('big-c', big))
    );
    const messages = [userMessage(':skill[big-a] :skill[big-b] :skill[big-c]')];
    const result = await injectActivatedSkillsContext(messages, engine);
    const text = systemTextOf(result);
    expect(text.length).toBeLessThanOrEqual(MAX_SKILL_ACTIVATION_TOTAL_CHARS + 2000);
    expect(text).toMatch(/omitted/i);
    expect(text).toContain('big-c');
  });

  it('caps the number of activations per message with an honest omission note', async () => {
    const names = Array.from(
      { length: MAX_ACTIVATED_SKILLS_PER_MESSAGE + 2 },
      (_, index) => `skill-${String.fromCharCode(97 + index)}`
    );
    const engine = makeEngine(mergeFs(...names.map((name) => skillFixture(name, `${name} body.`))));
    const messages = [userMessage(names.map((name) => `:skill[${name}]`).join(' '))];
    const result = await injectActivatedSkillsContext(messages, engine);
    const text = systemTextOf(result);
    expect(text).toContain(`${names[0]} body.`);
    expect(text).not.toContain(`${names.at(-1)} body.`);
    expect(text).toMatch(/omitted|not activated/i);
  });
});
