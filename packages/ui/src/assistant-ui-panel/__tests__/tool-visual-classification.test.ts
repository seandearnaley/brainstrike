// packages/ui/src/assistant-ui-panel/__tests__/tool-visual-classification.test.ts
import { describe, expect, it } from 'vitest';
import {
  categoryTintClasses,
  classifyRunEvent,
  classifyToolName,
  isInternalToolName,
} from '../tool-visual-classification';

describe('isInternalToolName', () => {
  it('matches brainstrike. and brainstrike_ prefixes, case-insensitively', () => {
    expect(isInternalToolName('brainstrike.readWorkspaceFile')).toBe(true);
    expect(isInternalToolName('brainstrike_readWorkspaceFile')).toBe(true);
    expect(isInternalToolName('Brainstrike.queryEmbeddingSpace')).toBe(true);
  });
  it('does not match external/mcp tool names', () => {
    expect(isInternalToolName('searchDocs')).toBe(false);
    expect(isInternalToolName('filesystem_read_file')).toBe(false);
  });
});

describe('classifyToolName', () => {
  it('returns internal for brainstrike tools and mcp otherwise', () => {
    expect(classifyToolName('brainstrike.queryEmbeddingSpace')).toBe('internal');
    expect(classifyToolName('some_mcp_tool')).toBe('mcp');
  });
});

describe('classifyRunEvent', () => {
  it('classifies by kind and tool metadata', () => {
    expect(classifyRunEvent('memory.working.loaded')).toBe('memory');
    expect(classifyRunEvent('tool.started', 'brainstrike.readWorkspaceFile')).toBe('internal');
    expect(classifyRunEvent('tool.completed', 'searchDocs')).toBe('mcp');
    expect(classifyRunEvent('run.step.started')).toBe('lifecycle');
    expect(classifyRunEvent('run.finished')).toBe('lifecycle');
  });
  it('falls back to lifecycle for a tool event without a tool name', () => {
    expect(classifyRunEvent('tool.started')).toBe('lifecycle');
  });
});

describe('categoryTintClasses', () => {
  it('returns distinct, non-empty class strings per category', () => {
    const cats = ['memory', 'internal', 'mcp', 'lifecycle'] as const;
    const rails = cats.map((c) => categoryTintClasses(c).rail);
    expect(new Set(rails).size).toBe(cats.length);
    for (const c of cats) {
      expect(categoryTintClasses(c).card.length).toBeGreaterThan(0);
      expect(categoryTintClasses(c).rail.length).toBeGreaterThan(0);
    }
  });
});
