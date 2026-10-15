import {
  toToolInputJsonSchema,
  validateToolInputValue,
} from '@brainstrike/assistant-contract/native-tool-schemas';
import { describe, expect, it } from 'vitest';
import { NATIVE_TOOL_INPUT_SCHEMAS } from '../tools/schemas';
import { normalizeManageWorktreeInput } from '../tools/schemas-worktrees';

/**
 * The subject is the REGISTERED input schema — the object the desktop registry
 * hands the provider and `validateToolInput` parses with — not the bare
 * authored declaration. The worktree tools are authored in Effect Schema
 * (ADR-0004, amended 2026-10-15), and it is `effectToolInputSchema` that binds
 * the closed-object decision to the emitted JSON Schema, so a test against the
 * bare `Schema.Struct` would assert the wrong strictness.
 */
const listWorktrees = NATIVE_TOOL_INPUT_SCHEMAS['brainstrike.listWorktrees'];
const manageWorktree = NATIVE_TOOL_INPUT_SCHEMAS['brainstrike.manageWorktree'];

const accepts = (schema: unknown, input: unknown): boolean =>
  validateToolInputValue(schema, input).success;

const issuesOf = (schema: unknown, input: unknown): string => {
  const result = validateToolInputValue(schema, input);
  if (result.success) {
    throw new Error('Expected the schema to reject this input');
  }
  return JSON.stringify(result.issues);
};

describe('listWorktrees registered input schema', () => {
  it('accepts an empty object and an explicit root', () => {
    expect(validateToolInputValue(listWorktrees, {})).toEqual({ success: true, value: {} });
    expect(validateToolInputValue(listWorktrees, { root: 'brainstrike' })).toEqual({
      success: true,
      value: { root: 'brainstrike' },
    });
  });

  it('rejects an unknown key at the strict provider envelope', () => {
    expect(accepts(listWorktrees, { rootId: 'x' })).toBe(false);
  });
});

describe('manageWorktree registered input schema', () => {
  it('accepts a create with a branch', () => {
    expect(accepts(manageWorktree, { action: 'create', branch: 'bs/fox' })).toBe(true);
  });

  it('rejects a create with no branch, naming the missing field', () => {
    expect(issuesOf(manageWorktree, { action: 'create' })).toContain('branch');
  });

  it('rejects an archive with no worktreeId, naming the missing field', () => {
    expect(issuesOf(manageWorktree, { action: 'archive' })).toContain('worktreeId');
  });

  it('accepts an archive with a worktreeId', () => {
    expect(accepts(manageWorktree, { action: 'archive', worktreeId: 'wt-9' })).toBe(true);
  });

  it('tolerates cross-action extras among the declared envelope keys', () => {
    // The settled manageCanvas ruling (2026-08-07): real models bundle fields,
    // and rejecting a VALID create that carries a stray worktreeId burns retry
    // tokens for nothing. `action` fully determines semantics.
    expect(
      accepts(manageWorktree, { action: 'create', branch: 'bs/fox', worktreeId: 'wt-1' })
    ).toBe(true);
  });

  it('rejects a genuinely unknown key', () => {
    expect(accepts(manageWorktree, { action: 'create', branch: 'bs/fox', detach: true })).toBe(
      false
    );
  });

  it('normalizes to the clean action branch, stripping tolerated extras', () => {
    expect(
      normalizeManageWorktreeInput({ action: 'create', branch: 'bs/fox', worktreeId: 'wt-1' })
    ).toEqual({ action: 'create', branch: 'bs/fox' });
  });

  it('treats a provider null on a declared optional as omission, not as a value', () => {
    // OpenAI strict mode makes every property required and sends `null` for the
    // ones the model is not using; `normalizeProviderNulls` is the one place
    // that is turned back into omission, for both schema producers.
    expect(
      validateToolInputValue(manageWorktree, {
        action: 'archive',
        baseRef: null,
        branch: null,
        force: null,
        name: null,
        root: null,
        worktreeId: 'wt-9',
      })
    ).toEqual({ success: true, value: { action: 'archive', worktreeId: 'wt-9' } });
  });

  it('rejects a null on a REQUIRED property instead of dropping it', () => {
    expect(accepts(manageWorktree, { action: null, worktreeId: 'wt-9' })).toBe(false);
  });
});

describe('worktree model-facing JSON Schema', () => {
  it('closes the object so an unknown key is the model mistake it is', () => {
    // Effect's JSON Schema emitter defaults `additionalProperties` to TRUE and
    // `Schema.toStandardJSONSchemaV1` takes no options, so an open object here
    // would mean the advertised contract and the enforced one had drifted.
    // OpenAI strict mode also requires `additionalProperties: false`.
    for (const schema of [listWorktrees, manageWorktree]) {
      expect(toToolInputJsonSchema(schema, 'draft-07')).toMatchObject({
        additionalProperties: false,
        type: 'object',
      });
    }
  });

  it('carries the draft-07 dialect, the enum, the bounds and every description', () => {
    expect(toToolInputJsonSchema(manageWorktree, 'draft-07')).toEqual({
      $schema: 'http://json-schema.org/draft-07/schema#',
      additionalProperties: false,
      properties: {
        action: {
          description: 'Worktree operation',
          enum: ['create', 'archive'],
          type: 'string',
        },
        baseRef: {
          description: 'Base ref for create; defaults to HEAD',
          maxLength: 255,
          minLength: 1,
          type: 'string',
        },
        branch: {
          description: 'Required for create',
          maxLength: 255,
          minLength: 1,
          type: 'string',
        },
        force: {
          description: 'Archive a dirty or unpushed worktree anyway; never overrides an active run',
          type: 'boolean',
        },
        name: {
          description: 'Directory name; defaults to the branch name',
          maxLength: 128,
          minLength: 1,
          type: 'string',
        },
        root: {
          description: 'Workspace root id or display name',
          maxLength: 512,
          minLength: 1,
          type: 'string',
        },
        worktreeId: { description: 'Required for archive', minLength: 1, type: 'string' },
      },
      required: ['action'],
      type: 'object',
    });
  });
});
