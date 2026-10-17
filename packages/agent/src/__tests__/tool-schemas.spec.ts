import { getToolSchemaDisplay } from '@brainstrike/assistant-contract/tool-metadata';
import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  GlobWorkspaceInputSchema,
  GrepSearchInputSchema,
  HybridSearchInputSchema,
  QueryEmbeddingSpaceInputSchema,
  validateToolInput,
} from '../tools/schemas';

describe('tool schemas', () => {
  it('passes through unknown tool names', () => {
    const ok = validateToolInput('custom.tool', { x: 1 });
    expect(ok.ok).toBe(true);
  });

  it('does not special-case legacy filesystem aliases', () => {
    const ok = validateToolInput('filesystem.list', { path: '' });
    expect(ok.ok).toBe(true);
  });

  it('does not advertise legacy filesystem aliases in schema display metadata', () => {
    expect(getToolSchemaDisplay('filesystem.list')).toBeUndefined();
  });

  it('validates workspace context read input, which names its files', () => {
    const ok = validateToolInput('brainstrike.readWorkspaceContext', {
      filePaths: ['/src/main.ts', '/src/utils.ts'],
      maxFiles: 2,
      tokenBudget: 4000,
    });
    expect(ok.ok).toBe(true);
    // No selected-context default and no Tapestry ranges are left to read (BST-2019).
    expect(validateToolInput('brainstrike.readWorkspaceContext', { maxFiles: 2 }).ok).toBe(false);
    expect(
      validateToolInput('brainstrike.readWorkspaceContext', {
        filePaths: ['/src/main.ts'],
        useTapestrySelections: true,
      }).ok
    ).toBe(false);
  });

  it('allows embedding-space queries to omit an explicit id for workspace-index defaulting', () => {
    const ok = validateToolInput('brainstrike.queryEmbeddingSpace', {
      query: 'where is context assembled?',
    });
    expect(ok.ok).toBe(true);
  });

  it('validates workspace-index embedding-space listing input', () => {
    const ok = validateToolInput('brainstrike.listEmbeddingSpaces', {
      includeStats: true,
      workspaceIndexOnly: true,
    });
    expect(ok.ok).toBe(true);
  });

  it('marks embedding set id as optional in query display metadata', () => {
    const schema = getToolSchemaDisplay('brainstrike.queryEmbeddingSpace');
    const embeddingSetParam = schema?.parameters.find((param) => param.name === 'embeddingSetId');
    expect(embeddingSetParam?.required).toBe(false);
  });

  it('documents workspace-index filtering for embedding-space listing', () => {
    const schema = getToolSchemaDisplay('brainstrike.listEmbeddingSpaces');
    const workspaceIndexOnly = schema?.parameters.find(
      (param) => param.name === 'workspaceIndexOnly'
    );
    expect(workspaceIndexOnly?.type).toBe('boolean');
  });

  it('validates globWorkspace input and rejects unknown fields (strict)', () => {
    expect(validateToolInput('brainstrike.globWorkspace', { pattern: '**/*.ts' }).ok).toBe(true);
    expect(
      validateToolInput('brainstrike.globWorkspace', {
        includeIgnored: true,
        limit: 50,
        offset: 0,
        pattern: 'src/**',
        root: 'app',
      }).ok
    ).toBe(true);
    // Missing required pattern → invalid.
    expect(validateToolInput('brainstrike.globWorkspace', {}).ok).toBe(false);
    // Unknown field → rejected by .strict().
    expect(
      validateToolInput('brainstrike.globWorkspace', { bogus: true, pattern: '*.ts' }).ok
    ).toBe(false);
  });

  it('documents globWorkspace in schema display metadata', () => {
    const display = getToolSchemaDisplay('brainstrike.globWorkspace');
    expect(display).toBeDefined();
    expect(display?.parameters.find((param) => param.name === 'pattern')?.required).toBe(true);
    expect(display?.parameters.find((param) => param.name === 'includeIgnored')?.type).toBe(
      'boolean'
    );
  });

  it('preserves omitted and explicit root qualifiers for runtime scope resolution', () => {
    const rootSchemas = [
      GlobWorkspaceInputSchema.fields.root,
      GrepSearchInputSchema.fields.root,
      HybridSearchInputSchema.fields.root,
      QueryEmbeddingSpaceInputSchema.fields.root,
    ];

    // The owning runtime tests exercise thread-wide versus explicit-folder
    // resolution. Parsing must not turn omission into a selected folder.
    for (const schema of rootSchemas) {
      expect(Schema.decodeSync(Schema.UndefinedOr(schema))(undefined)).toBeUndefined();
      expect(Schema.decodeSync(schema)('bravo-root')).toBe('bravo-root');
      expect(Schema.is(schema)(['bravo-root'])).toBe(false);
      expect(Schema.is(schema)(42)).toBe(false);
    }
  });

  it('executeCommand description reflects the per-call approval flow (no stale "no approval prompt" text)', () => {
    const display = getToolSchemaDisplay('brainstrike.executeCommand');
    expect(display).toBeDefined();
    const desc = (display?.description ?? '').toLowerCase();
    // The approval flow shipped — the description must not claim otherwise.
    expect(desc).not.toContain('no interactive approval prompt');
    expect(desc).not.toContain('gating is available but off');
    expect(desc).toContain('approval');
  });

  it('rejects an invalid regex grepSearch pattern at parse when isRegex=true (fail-fast)', () => {
    // A regex-special string is fine as PLAIN text (isRegex omitted/false).
    expect(validateToolInput('brainstrike.grepSearch', { pattern: 'a(b' }).ok).toBe(true);
    // A valid regex with isRegex=true is accepted.
    expect(
      validateToolInput('brainstrike.grepSearch', { isRegex: true, pattern: 'foo.*bar' }).ok
    ).toBe(true);
    // An INVALID regex with isRegex=true is rejected at parse — not deferred to execution
    // (fail-fast / no silent fallback).
    expect(validateToolInput('brainstrike.grepSearch', { isRegex: true, pattern: 'a(b' }).ok).toBe(
      false
    );
    expect(
      validateToolInput('brainstrike.grepSearch', { isRegex: true, pattern: '[z-a]' }).ok
    ).toBe(false);
  });

  it('validates webSearch input and rejects unknown fields (strict)', () => {
    expect(validateToolInput('brainstrike.webSearch', { query: 'react useEffect' }).ok).toBe(true);
    expect(
      validateToolInput('brainstrike.webSearch', { maxResults: 3, query: 'react useEffect' }).ok
    ).toBe(true);
    // Missing required query → invalid.
    expect(validateToolInput('brainstrike.webSearch', {}).ok).toBe(false);
    // maxResults over the cap → invalid.
    expect(validateToolInput('brainstrike.webSearch', { maxResults: 50, query: 'x y' }).ok).toBe(
      false
    );
    // Unknown field → rejected by .strict().
    expect(validateToolInput('brainstrike.webSearch', { bogus: true, query: 'react' }).ok).toBe(
      false
    );
  });

  it('accepts short markerless LSP identifiers', () => {
    for (const match of ['x', 'id', '$']) {
      expect(
        validateToolInput('brainstrike.lspInspect', {
          line: 1,
          match,
          path: '/src/sym.ts',
        }).ok
      ).toBe(true);
    }
  });

  it('documents webSearch in schema display metadata with the external-service caveat', () => {
    const display = getToolSchemaDisplay('brainstrike.webSearch');
    expect(display).toBeDefined();
    expect(display?.parameters.find((param) => param.name === 'query')?.required).toBe(true);
    expect(display?.description).toContain('EXTERNAL WEB-SEARCH SERVICE');
  });

  it('retires the context curation tools (BST-2019)', () => {
    expect(getToolSchemaDisplay('brainstrike.updateWorkspaceContextSelection')).toBeUndefined();
    expect(getToolSchemaDisplay('brainstrike.updateWorkspaceTapestrySelections')).toBeUndefined();
  });

  it('validates manageTaskList input and rejects malformed lists (strict)', () => {
    expect(
      validateToolInput('brainstrike.manageTaskList', {
        tasks: [
          { activeForm: 'Reading the spec', content: 'Read the spec', status: 'completed' },
          {
            activeForm: 'Implementing the parser',
            content: 'Implement parser',
            status: 'in_progress',
          },
        ],
      }).ok
    ).toBe(true);
    // An empty list is a valid whole-list-replace (clears the plan).
    expect(validateToolInput('brainstrike.manageTaskList', { tasks: [] }).ok).toBe(true);
    // Unknown status → rejected.
    expect(
      validateToolInput('brainstrike.manageTaskList', {
        tasks: [{ activeForm: 'Doing', content: 'Do', status: 'blocked' }],
      }).ok
    ).toBe(false);
    // Missing activeForm → rejected.
    expect(
      validateToolInput('brainstrike.manageTaskList', {
        tasks: [{ content: 'Do', status: 'pending' }],
      }).ok
    ).toBe(false);
    // Over the 50-task cap → rejected.
    expect(
      validateToolInput('brainstrike.manageTaskList', {
        tasks: Array.from({ length: 51 }, (_, index) => ({
          activeForm: `Doing ${index}`,
          content: `Do ${index}`,
          status: 'pending' as const,
        })),
      }).ok
    ).toBe(false);
    // Unknown field → rejected by .strict().
    expect(
      validateToolInput('brainstrike.manageTaskList', {
        bogus: true,
        tasks: [{ activeForm: 'Doing', content: 'Do', status: 'pending' }],
      }).ok
    ).toBe(false);
  });

  it('documents manageTaskList in schema display metadata', () => {
    const display = getToolSchemaDisplay('brainstrike.manageTaskList');
    expect(display).toBeDefined();
    expect(display?.parameters.find((param) => param.name === 'tasks')?.required).toBe(true);
    expect(display?.parameters.find((param) => param.name === 'tasks')?.type).toBe('array');
  });

  it('validates submitPlan input and rejects malformed plans (strict)', () => {
    expect(
      validateToolInput('brainstrike.submitPlan', {
        overview: 'Refactor the parser.',
        steps: [{ title: 'Read the code' }, { detail: 'carefully', title: 'Rewrite it' }],
        title: 'Parser refactor',
      }).ok
    ).toBe(true);
    // Missing required overview → invalid.
    expect(
      validateToolInput('brainstrike.submitPlan', { steps: [{ title: 'x' }], title: 't' }).ok
    ).toBe(false);
    // Empty steps → invalid (min 1).
    expect(
      validateToolInput('brainstrike.submitPlan', { overview: 'o', steps: [], title: 't' }).ok
    ).toBe(false);
    // Unknown field → rejected by .strict().
    expect(
      validateToolInput('brainstrike.submitPlan', {
        bogus: true,
        overview: 'o',
        steps: [{ title: 'x' }],
        title: 't',
      }).ok
    ).toBe(false);
  });

  it('validates askUser input and rejects malformed questions (strict)', () => {
    expect(validateToolInput('brainstrike.askUser', { question: 'What city?' }).ok).toBe(true);
    expect(
      validateToolInput('brainstrike.askUser', {
        options: [{ label: 'A' }, { description: 'the other', label: 'B' }],
        question: 'Pick one',
        selectionMode: 'multi_select',
      }).ok
    ).toBe(true);
    // Missing required question → invalid.
    expect(validateToolInput('brainstrike.askUser', {}).ok).toBe(false);
    // Unknown selectionMode → rejected.
    expect(
      validateToolInput('brainstrike.askUser', { question: 'q', selectionMode: 'triple' }).ok
    ).toBe(false);
    // Unknown field → rejected by .strict().
    expect(validateToolInput('brainstrike.askUser', { bogus: true, question: 'q' }).ok).toBe(false);
  });

  it('documents submitPlan and askUser in schema display metadata', () => {
    const submitPlan = getToolSchemaDisplay('brainstrike.submitPlan');
    expect(submitPlan).toBeDefined();
    expect(submitPlan?.parameters.find((param) => param.name === 'steps')?.required).toBe(true);
    const askUser = getToolSchemaDisplay('brainstrike.askUser');
    expect(askUser).toBeDefined();
    expect(askUser?.parameters.find((param) => param.name === 'question')?.required).toBe(true);
  });
});
