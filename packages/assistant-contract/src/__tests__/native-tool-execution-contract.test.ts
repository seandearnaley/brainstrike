import { describe, expect, it } from 'vitest';
import { NATIVE_TOOLS } from '../native-tools/index.js';
import { isEffectToolInputSchema } from '../native-tools/schemas/effect-tool-input.js';
import {
  toToolInputJsonSchema,
  validateToolInputValue,
} from '../native-tools/schemas/tool-input-schema.js';
import { encodeToolOutputArtifactCursor } from '../tool-output-artifact.js';

const cursor = encodeToolOutputArtifactCursor(
  {
    byteLength: 12,
    expiresAt: '2099-01-01T00:00:00.000Z',
    format: 'text',
    id: 'contract-artifact',
  },
  0
);

// Independent authored examples, not values generated from the schemas under
// test. A new catalog entry needs an executable example before this can pass.
const examples: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  'brainstrike.askUser': { options: [{ label: 'Continue' }], question: 'Continue?' },
  'brainstrike.browserGetPageText': {},
  'brainstrike.browserNavigate': { url: 'https://example.com' },
  'brainstrike.browserReadPage': {},
  'brainstrike.deleteWorkspaceFile': { path: 'src/a.ts' },
  'brainstrike.executeCommand': { command: 'echo fixture' },
  'brainstrike.findWorkspaceSymbol': { path: 'src/a.ts', query: 'symbol' },
  'brainstrike.globWorkspace': { pattern: '*.ts' },
  'brainstrike.grepSearch': { pattern: 'fixture' },
  'brainstrike.hybridSearch': { query: 'fixture' },
  'brainstrike.inspectCommandSessions': { operation: { action: 'list' } },
  'brainstrike.listEmbeddingSpaces': {},
  'brainstrike.listWorkspaceContext': {},
  'brainstrike.listWorktrees': {},
  'brainstrike.lspInspect': { line: 1, match: 'symbol', path: 'src/a.ts' },
  'brainstrike.manageCanvas': { action: 'list' },
  'brainstrike.manageCommandSession': { operation: { action: 'start', command: 'echo fixture' } },
  'brainstrike.manageTaskList': {
    tasks: [{ activeForm: 'Checking', content: 'Check', status: 'pending' }],
  },
  'brainstrike.manageWorktree': { action: 'create', branch: 'codex/fixture' },
  'brainstrike.queryDiagnostics': { mode: 'events' },
  'brainstrike.queryEmbeddingSpace': { query: 'fixture' },
  'brainstrike.readToolOutputArtifact': { cursor },
  'brainstrike.readWorkspaceContext': { filePaths: ['src/a.ts'] },
  'brainstrike.readWorkspaceDirectory': {},
  'brainstrike.readWorkspaceFile': { path: 'src/a.ts' },
  'brainstrike.renameWorkspaceFile': { fromPath: 'src/a.ts', toPath: 'src/b.ts' },
  'brainstrike.runPython': { code: 'print("fixture")' },
  'brainstrike.runSkillScript': {
    cwd: 'src',
    root: 'fixture',
    runtime: 'node',
    scriptPath: 'scripts/check.ts',
    skillName: 'checker',
  },
  'brainstrike.stringReplaceWorkspaceFile': { newStr: 'after', oldStr: 'before', path: 'src/a.ts' },
  'brainstrike.submitPlan': {
    overview: 'Validate the contract',
    steps: [{ title: 'Check' }],
    title: 'Fixture',
  },
  'brainstrike.webExtract': { urls: ['https://example.com'] },
  'brainstrike.webSearch': { query: 'fixture' },
  'brainstrike.writeWorkspaceFile': { content: 'fixture', path: 'src/a.ts' },
  skill: { name: 'checker' },
  skill_read: { path: 'README.md', skillName: 'checker' },
  skill_search: { query: 'fixture' },
};

function registered(id: string) {
  const tool = NATIVE_TOOLS.find((entry) => entry.id === id);
  if (!tool) {
    throw new Error(`Missing registered tool ${id}`);
  }
  return tool;
}

describe('every registered native tool has an executable contract', () => {
  it('accounts for the exact catalog, including skills and non-search families', () => {
    expect(Object.keys(examples).length).toBeGreaterThan(0);
    expect(Object.keys(examples).sort()).toEqual(NATIVE_TOOLS.map((tool) => tool.id).sort());
  });

  it.each(Object.entries(examples))(
    '%s validates its example and preserves its explicit excess-key policy',
    (id, input) => {
      const tool = registered(id);
      const schema = tool.inputSchema;
      expect(isEffectToolInputSchema(schema)).toBe(true);
      expect(validateToolInputValue(schema, input)).toMatchObject({ success: true });
      const invalid = validateToolInputValue(schema, { ...input, unexpected: 'must refuse' });
      if (tool.kind === 'skill') {
        // Vendor skill inputs deliberately strip extras despite advertising a
        // closed provider grammar. Their execution remains owned by Mastra.
        expect(invalid).toEqual(validateToolInputValue(schema, input));
      } else {
        expect(invalid.success).toBe(false);
        if (invalid.success) {
          throw new Error(`${id} admitted an excess key`);
        }
        expect(invalid.issues.map((issue) => issue.path)).toContainEqual(['unexpected']);
      }
      expect(validateToolInputValue(schema, null).success).toBe(false);
    }
  );

  it.each(Object.entries(examples))(
    '%s keeps both provider dialects closed and defaults synchronous',
    (id, input) => {
      const tool = registered(id);
      const schema = tool.inputSchema;
      const expected = validateToolInputValue(schema, input);
      for (const target of ['draft-07', 'draft-2020-12'] as const) {
        const projection = toToolInputJsonSchema(schema, target);
        expect(projection['additionalProperties']).toBe(false);
        const properties = projection['properties'] as Record<string, unknown>;
        const required = projection['required'] as string[] | undefined;
        const optional = Object.keys(properties).filter(
          (key) => !(required?.includes(key) || key in input)
        );
        const providerInput = {
          ...input,
          ...Object.fromEntries(optional.map((key) => [key, null])),
        };
        const result = validateToolInputValue(schema, providerInput);
        if (tool.kind === 'skill' && optional.length > 0) {
          // These retained vendor inputs do not normalize null into omission.
          expect(result.success).toBe(false);
          if (result.success) {
            throw new Error(`${id} silently normalized vendor nulls`);
          }
          for (const key of optional) {
            expect(result.issues.map((issue) => issue.path)).toContainEqual([key]);
          }
        } else {
          expect(result).toEqual(expected);
        }
      }
      // The actual producer's Standard Schema validator must execute, not hand
      // an unrun Effect or asynchronous default to its synchronous caller.
      expect(schema['~standard'].validate(input)).not.toBeInstanceOf(Promise);
    }
  );

  it.each([
    [
      'brainstrike.askUser',
      { options: [{ label: 'Yes', surprise: true }], question: 'Continue?' },
      ['options', 0, 'surprise'],
    ],
    [
      'brainstrike.manageTaskList',
      { tasks: [{ activeForm: 'Checking', content: 'Check', status: 'pending', surprise: true }] },
      ['tasks', 0, 'surprise'],
    ],
    [
      'brainstrike.submitPlan',
      { overview: 'Check', steps: [{ surprise: true, title: 'Check' }], title: 'Fixture' },
      ['steps', 0, 'surprise'],
    ],
    [
      'brainstrike.inspectCommandSessions',
      { operation: { action: 'list', sessionId: 'wrong-branch' } },
      ['operation', 'sessionId'],
    ],
  ] as const)(
    '%s refuses the intended nested path, rather than an unrelated producer failure',
    (id, input, path) => {
      const invalid = validateToolInputValue(registered(id).inputSchema, input);
      expect(invalid.success).toBe(false);
      if (invalid.success) {
        throw new Error(`${id} admitted nested excess input`);
      }
      expect(invalid.issues.map((issue) => issue.path)).toContainEqual(path);
    }
  );

  it('distinguishes a bypassed producer from ordinary invalid tool input', () => {
    const bypass = {
      '~standard': { validate: () => ({ value: {} }), vendor: 'fixture', version: 1 },
    };
    expect(() => validateToolInputValue(bypass, {})).toThrow('not authored by the Effect producer');
    expect(() => toToolInputJsonSchema(bypass)).toThrow('not authored by the Effect producer');
  });
});
