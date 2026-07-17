/**
 * SKILL.md frontmatter parsing (Agent Skills spec, https://agentskills.io).
 *
 * Skills REQUIRE YAML frontmatter (unlike user /commands, where a fence-less
 * file is a whole-file template), so a missing or unterminated fence fails
 * CLOSED with a structured error — never a silent half-parse. The YAML block
 * is parsed with the real `yaml` package (block scalars, quoting, and nested
 * `metadata:` maps all behave per spec), matching what @mastra/core's own
 * gray-matter-based parser accepts.
 */

import { parse as parseYaml } from 'yaml';

export type SkillMarkdownParseResult =
  | { readonly body: string; readonly frontmatter: Record<string, unknown>; readonly ok: true }
  | { readonly error: string; readonly ok: false };

const FRONTMATTER_FENCE = '---';

/** Parse a SKILL.md file into its YAML frontmatter object and markdown body. */
export function parseSkillMarkdown(content: string): SkillMarkdownParseResult {
  // Strip a leading UTF-8 BOM so a BOM-prefixed `---` still opens frontmatter.
  const normalized = content.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines[0] !== FRONTMATTER_FENCE) {
    return {
      error:
        'SKILL.md must start with a `---` YAML frontmatter fence (name + description are required)',
      ok: false,
    };
  }

  let closingIndex = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === FRONTMATTER_FENCE) {
      closingIndex = index;
      break;
    }
  }
  if (closingIndex === -1) {
    return { error: 'SKILL.md frontmatter fence is never closed', ok: false };
  }

  const yamlBlock = lines.slice(1, closingIndex).join('\n');
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlBlock);
  } catch (error) {
    return {
      error: `SKILL.md frontmatter is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
      ok: false,
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'SKILL.md frontmatter must be a YAML mapping', ok: false };
  }

  return {
    body: lines
      .slice(closingIndex + 1)
      .join('\n')
      .trim(),
    frontmatter: parsed as Record<string, unknown>,
    ok: true,
  };
}
