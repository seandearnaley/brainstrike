/**
 * Skill metadata validation — a faithful mirror of @mastra/core's
 * `validateSkillMetadata` (dist/workspace/skills/schemas), which Mastra does
 * NOT export publicly. Rules and error messages match the Agent Skills spec
 * (https://agentskills.io/specification) exactly as Mastra enforces them, so a
 * skill this scanner accepts is a skill Mastra's own loaders would accept:
 *
 * - `name`: 1–64 chars of [a-z0-9-], no leading/trailing hyphen, no `--`,
 *   and must match the containing directory's name.
 * - `description`: 1–1024 chars, not whitespace-only.
 * - `license` string, `user-invocable` boolean, `metadata` object — optional.
 * - Instructions over ~5000 estimated tokens or 500 lines are WARNINGS
 *   (the spec's recommended limits), never errors.
 */

export const SKILL_LIMITS = {
  /** Max characters for the description field. */
  // biome-ignore lint/style/useNamingConvention: mirrors Mastra's SKILL_LIMITS keys.
  MAX_DESCRIPTION_LENGTH: 1024,
  /** Recommended max lines for SKILL.md instructions. */
  // biome-ignore lint/style/useNamingConvention: mirrors Mastra's SKILL_LIMITS keys.
  MAX_INSTRUCTION_LINES: 500,
  /** Recommended max tokens for instructions. */
  // biome-ignore lint/style/useNamingConvention: mirrors Mastra's SKILL_LIMITS keys.
  MAX_INSTRUCTION_TOKENS: 5000,
  /** Max characters for the name field. */
  // biome-ignore lint/style/useNamingConvention: mirrors Mastra's SKILL_LIMITS keys.
  MAX_NAME_LENGTH: 64,
} as const;

export interface SkillValidationResult {
  readonly errors: readonly string[];
  readonly valid: boolean;
  readonly warnings: readonly string[];
}

function validateSkillName(name: unknown): string[] {
  const errors: string[] = [];
  if (typeof name !== 'string') {
    return [`name: Expected string, received ${typeof name}`];
  }
  if (name.length === 0) {
    return ['name: Skill name cannot be empty'];
  }
  if (name.length > SKILL_LIMITS.MAX_NAME_LENGTH) {
    errors.push(`name: Skill name must be ${SKILL_LIMITS.MAX_NAME_LENGTH} characters or less`);
  }
  if (!/^[a-z0-9-]+$/.test(name)) {
    errors.push('name: Skill name must contain only lowercase letters, numbers, and hyphens');
  }
  if (name.startsWith('-') || name.endsWith('-')) {
    errors.push('name: Skill name must not start or end with a hyphen');
  }
  if (name.includes('--')) {
    errors.push('name: Skill name must not contain consecutive hyphens');
  }
  return errors;
}

function validateSkillDescription(description: unknown): string[] {
  if (typeof description !== 'string') {
    return [`description: Expected string, received ${typeof description}`];
  }
  if (description.length === 0) {
    return ['description: Skill description cannot be empty'];
  }
  const errors: string[] = [];
  if (description.length > SKILL_LIMITS.MAX_DESCRIPTION_LENGTH) {
    errors.push(
      `description: Skill description must be ${SKILL_LIMITS.MAX_DESCRIPTION_LENGTH} characters or less`
    );
  }
  if (description.trim().length === 0) {
    errors.push('description: Skill description cannot be only whitespace');
  }
  return errors;
}

/** Word-count heuristic matching Mastra's estimateTokens (words × 1.3). */
function estimateTokens(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.ceil(words * 1.3);
}

function validateOptionalFields(data: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const license = data['license'];
  if (license !== undefined && license !== null && typeof license !== 'string') {
    errors.push(`license: Expected string, received ${typeof license}`);
  }
  const userInvocable = data['user-invocable'];
  if (userInvocable !== undefined && typeof userInvocable !== 'boolean') {
    errors.push(`user-invocable: Expected boolean, received ${typeof userInvocable}`);
  }
  const meta = data['metadata'];
  if (meta !== undefined && meta !== null && (typeof meta !== 'object' || Array.isArray(meta))) {
    errors.push(
      `metadata: Expected object, received ${Array.isArray(meta) ? 'array' : typeof meta}`
    );
  }
  return errors;
}

/** Recommended-size warnings from the Agent Skills spec (never errors). */
function collectInstructionWarnings(instructions: string | undefined): string[] {
  if (!instructions) {
    return [];
  }
  const warnings: string[] = [];
  const lineCount = instructions.split('\n').length;
  if (lineCount > SKILL_LIMITS.MAX_INSTRUCTION_LINES) {
    warnings.push(
      `Instructions have ${lineCount} lines (recommended: <${SKILL_LIMITS.MAX_INSTRUCTION_LINES}). Consider moving content to references/.`
    );
  }
  const tokenEstimate = estimateTokens(instructions);
  if (tokenEstimate > SKILL_LIMITS.MAX_INSTRUCTION_TOKENS) {
    warnings.push(
      `Instructions have ~${tokenEstimate} estimated tokens (recommended: <${SKILL_LIMITS.MAX_INSTRUCTION_TOKENS}). Consider moving content to references/.`
    );
  }
  return warnings;
}

/**
 * Validate parsed skill frontmatter (+ optional dirName match and instruction
 * size warnings). Mirrors @mastra/core's validateSkillMetadata semantics.
 */
export function validateSkillMetadata(
  metadata: unknown,
  dirName?: string,
  instructions?: string
): SkillValidationResult {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    const received =
      metadata === null ? 'null' : Array.isArray(metadata) ? 'array' : typeof metadata;
    return { errors: [`Expected object, received ${received}`], valid: false, warnings: [] };
  }
  const data = metadata as Record<string, unknown>;
  const errors: string[] = [
    ...validateSkillName(data['name']),
    ...validateSkillDescription(data['description']),
    ...validateOptionalFields(data),
  ];
  if (dirName && typeof data['name'] === 'string' && data['name'] !== dirName) {
    errors.push(`Skill name "${data['name']}" must match directory name "${dirName}"`);
  }
  return {
    errors,
    valid: errors.length === 0,
    warnings: collectInstructionWarnings(instructions),
  };
}
