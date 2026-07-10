import { describe, expect, it } from 'vitest';
import { NATIVE_TOOL_DEFAULTS } from '../tool-categories';
import { TOOL_DESCRIPTIONS } from '../tool-descriptions';

describe('TOOL_DESCRIPTIONS', () => {
  it('provides a non-empty description for EVERY native tool (no generic-label fallback)', () => {
    // The settings UI + tool menu render `TOOL_DESCRIPTIONS[id] ?? "Native tool: <id>"`;
    // a missing entry silently degrades to that generic label, hiding the tool's
    // real (often destructive) behavior. Every id in NATIVE_TOOL_DEFAULTS must have
    // a real description so this registry stays in lockstep with the tool catalog.
    for (const id of Object.keys(NATIVE_TOOL_DEFAULTS)) {
      const description = TOOL_DESCRIPTIONS[id];
      expect(description, `missing description for ${id}`).toBeTruthy();
      expect((description ?? '').trim().length, `empty description for ${id}`).toBeGreaterThan(0);
    }
  });

  it('does not carry descriptions for ids absent from the native-tool catalog', () => {
    const knownIds = new Set(Object.keys(NATIVE_TOOL_DEFAULTS));
    for (const id of Object.keys(TOOL_DESCRIPTIONS)) {
      expect(knownIds.has(id), `stale description for unknown tool ${id}`).toBe(true);
    }
  });
});
