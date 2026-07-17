/**
 * Agent Skills contract tests: durable preference keys, the `:skill[name]`
 * activation directive codec, and the serializable scan-entry shapes shared
 * between the desktop main process (scanner/IPC) and the renderer (settings
 * panel, composer slash menu, preferences store).
 */

import { describe, expect, it } from 'vitest';
import {
  deriveSkillPreferenceKey,
  extractSkillDirectives,
  MAX_ACTIVATED_SKILLS_PER_MESSAGE,
  type SkillScanEntrySummary,
  type SkillSourceTier,
  type SkillsContextRequest,
  serializeSkillDirective,
} from '../skills.js';

describe('deriveSkillPreferenceKey', () => {
  it('keys a root-scoped skill by the durable DB roots.id plus name', () => {
    expect(deriveSkillPreferenceKey({ name: 'pdf-processing', sourceRootId: 'root-uuid-1' })).toBe(
      'root:root-uuid-1:pdf-processing'
    );
  });

  it('keys a global skill by name only (brainstrike and claude tiers share identity)', () => {
    expect(deriveSkillPreferenceKey({ name: 'code-review' })).toBe('global:code-review');
  });

  it('produces distinct keys for the same name in different scopes', () => {
    const global = deriveSkillPreferenceKey({ name: 'x' });
    const rootA = deriveSkillPreferenceKey({ name: 'x', sourceRootId: 'a' });
    const rootB = deriveSkillPreferenceKey({ name: 'x', sourceRootId: 'b' });
    expect(new Set([global, rootA, rootB]).size).toBe(3);
  });
});

describe('skill activation directive', () => {
  it('serializes a name into the :skill[name] directive', () => {
    expect(serializeSkillDirective('pdf-processing')).toBe(':skill[pdf-processing]');
  });

  it('round-trips: extract finds serialized directives', () => {
    const text = `Please summarize. ${serializeSkillDirective('pdf-processing')}`;
    expect(extractSkillDirectives(text)).toEqual(['pdf-processing']);
  });

  it('extracts multiple directives in order and dedupes repeats', () => {
    const text = ':skill[alpha] then :skill[beta] and :skill[alpha] again';
    expect(extractSkillDirectives(text)).toEqual(['alpha', 'beta']);
  });

  it('ignores malformed names (uppercase, underscores, over-long) as inert text', () => {
    const overlong = 'a'.repeat(65);
    const text = `:skill[NotValid] :skill[snake_case] :skill[${overlong}] :skill[]`;
    expect(extractSkillDirectives(text)).toEqual([]);
  });

  it('accepts names at the 64-char boundary', () => {
    const name = 'a'.repeat(64);
    expect(extractSkillDirectives(`:skill[${name}]`)).toEqual([name]);
  });

  it('returns an empty list for text without directives', () => {
    expect(extractSkillDirectives('no directives here')).toEqual([]);
  });

  it('exposes a bounded per-message activation cap', () => {
    expect(MAX_ACTIVATED_SKILLS_PER_MESSAGE).toBeGreaterThan(0);
    expect(MAX_ACTIVATED_SKILLS_PER_MESSAGE).toBeLessThanOrEqual(16);
  });
});

describe('contract shapes', () => {
  it('SkillScanEntrySummary + SkillsContextRequest compile as serializable shapes', () => {
    const tier: SkillSourceTier = 'root-brainstrike';
    const entry: SkillScanEntrySummary = {
      absPath: '/repo/.brainstrike/skills/pdf-processing',
      description: 'Extract text from PDFs',
      dirName: 'pdf-processing',
      name: 'pdf-processing',
      preferenceKey: 'root:r1:pdf-processing',
      sourceRootId: 'r1',
      status: 'ok',
      tier,
      userInvocable: true,
    };
    const invalid: SkillScanEntrySummary = {
      absPath: '/repo/.claude/skills/broken',
      dirName: 'broken',
      errors: ['name: Skill name cannot be empty'],
      status: 'invalid',
      tier: 'root-claude',
    };
    const shadowed: SkillScanEntrySummary = {
      absPath: '/home/.claude/skills/pdf-processing',
      dirName: 'pdf-processing',
      name: 'pdf-processing',
      shadowedBy: { absPath: entry.absPath, tier: entry.tier },
      status: 'shadowed',
      tier: 'global-claude',
    };
    const preference: SkillsContextRequest = {
      disabledSkillKeys: ['global:code-review'],
      masterEnabled: true,
    };
    expect([entry, invalid, shadowed].map((e) => e.status)).toEqual(['ok', 'invalid', 'shadowed']);
    expect(preference.masterEnabled).toBe(true);
  });
});
