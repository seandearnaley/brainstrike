// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  resolveAssistantMemoryResourceId,
  WORKSPACE_MEMORY_RESOURCE_ID,
} from '../assistant-memory-resource';

describe('assistant memory resource id', () => {
  it('is a stable workspace-global constant (not a filesystem path)', () => {
    expect(WORKSPACE_MEMORY_RESOURCE_ID).toBe('brainstrike:workspace');
    // Must not look like a root path — that coupling is exactly what broke.
    expect(WORKSPACE_MEMORY_RESOURCE_ID.startsWith('/')).toBe(false);
  });

  it('returns the workspace-global id when no override is provided', () => {
    expect(resolveAssistantMemoryResourceId()).toBe(WORKSPACE_MEMORY_RESOURCE_ID);
    expect(resolveAssistantMemoryResourceId(null)).toBe(WORKSPACE_MEMORY_RESOURCE_ID);
    expect(resolveAssistantMemoryResourceId(undefined)).toBe(WORKSPACE_MEMORY_RESOURCE_ID);
    expect(resolveAssistantMemoryResourceId('')).toBe(WORKSPACE_MEMORY_RESOURCE_ID);
  });

  it('honors an explicit, non-empty override', () => {
    expect(resolveAssistantMemoryResourceId('custom-resource')).toBe('custom-resource');
  });

  it('never returns null/undefined so the assistant is usable with zero roots', () => {
    const resolved = resolveAssistantMemoryResourceId(null);
    expect(typeof resolved).toBe('string');
    expect(resolved.length).toBeGreaterThan(0);
  });
});
